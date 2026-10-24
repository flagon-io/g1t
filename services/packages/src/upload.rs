//! Writing a blob that arrives in chunks of any size, over any number of
//! requests.
//!
//! R2 takes a multipart upload only when every part but the last is the
//! same size, and `docker push` cuts its chunks however it likes, so bytes
//! are gathered into parts of [`PART_BYTES`] here. Whatever is left at the
//! end of a request (less than a part) is kept as a small object of its
//! own, the tail, and read back by the next request. A blob that never
//! fills a part is stored whole, at its digest's key, when it finishes.
//! The digest is worked out as the bytes pass, so finishing never reads
//! the blob back.
//!
//! A part goes up while the request's next bytes are read: each part is
//! one request to the store, which takes about two seconds for 10 MiB, so
//! reading nothing until it was in held one request to about 4 MB/s
//! (#474). Up to [`PARTS_IN_FLIGHT`] of a request's parts go at once, and
//! no more than [`ISOLATE_PARTS`] across the requests this Worker is
//! answering, which bounds what they hold in memory together; a request's
//! first part always goes, as one did before.

use std::cell::Cell;
use std::collections::VecDeque;
use std::future::{Future, poll_fn};
use std::pin::Pin;
use std::task::Poll;

use serde::{Deserialize, Serialize};
use worker::Result;

use crate::digest::{Digest, Sha256};
use crate::store::{BlobStore, Part};

/// The size of every part but the last: over R2's least (5 MiB), and
/// small enough to hold in memory while it fills.
pub const PART_BYTES: usize = 10 * 1024 * 1024;

/// The most parts one request has going up at once.
pub const PARTS_IN_FLIGHT: usize = 3;

/// The most parts going up at once across every request this Worker
/// answers: each holds its 10 MiB until the store has it, in a Worker of
/// 128 MB. A request's first part goes beyond it.
pub const ISOLATE_PARTS: usize = 6;

thread_local! {
    /// Parts going up now, across every request this Worker answers.
    static SENDING: Cell<usize> = const { Cell::new(0) };
}

/// One part counted in [`SENDING`] while it goes up; let go when it is in,
/// fails or is dropped.
struct Sending;

impl Sending {
    fn start() -> Sending {
        SENDING.with(|n| n.set(n.get() + 1));
        Sending
    }
}

impl Drop for Sending {
    fn drop(&mut self) {
        SENDING.with(|n| n.set(n.get().saturating_sub(1)));
    }
}

/// Whether a request with `mine` parts going up may start another now.
pub fn may_send(mine: usize, everyone: usize) -> bool {
    mine == 0 || (mine < PARTS_IN_FLIGHT && everyone < ISOLATE_PARTS)
}

/// A part going up, which says what the store made of it when it is in.
type PartSent<'a> = Pin<Box<dyn Future<Output = Result<Part>> + 'a>>;

/// Polls `future` once, which starts its request to the store; its answer
/// is `Some` if it has one already.
async fn poll_once<F: Future + Unpin>(future: &mut F) -> Option<F::Output> {
    poll_fn(|cx| {
        Poll::Ready(match Pin::new(&mut *future).poll(cx) {
            Poll::Ready(output) => Some(output),
            Poll::Pending => None,
        })
    })
    .await
}

/// How many whole parts `buffered` bytes make, and how many are left over.
pub fn whole_parts(buffered: usize, part: usize) -> (usize, usize) {
    (buffered / part, buffered % part)
}

/// Where an upload's parts and tail are kept, by its id.
pub fn parts_key(id: &str) -> String {
    format!("blobs/parts/{id}")
}

pub fn tail_key(id: &str) -> String {
    format!("uploads/{id}/tail")
}

/// An upload's progress, as kept on its row between requests.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Progress {
    pub id: String,
    /// Set once the first whole part went up.
    pub multipart_id: Option<String>,
    pub parts: Vec<Part>,
    /// Bytes received so far.
    pub offset: u64,
    /// Bytes in the tail object, waiting for the next part.
    pub tail: u64,
    #[serde(skip)]
    pub hasher: Sha256,
}

impl Progress {
    pub fn new(id: &str) -> Progress {
        Progress { id: id.to_owned(), multipart_id: None, parts: Vec::new(), offset: 0, tail: 0, hasher: Sha256::new() }
    }
}

/// How a finished upload ended.
#[derive(Debug, PartialEq, Eq)]
pub enum Finished {
    /// Stored at `key`.
    Stored { key: String, size: u64 },
    /// The blob was already stored; these bytes were let go.
    Duplicate { size: u64 },
    /// The bytes have another digest than the client said; let go.
    Mismatch { actual: Digest },
}

/// An upload being written by one request.
pub struct Writer<'a, S: BlobStore> {
    store: &'a S,
    progress: Progress,
    buffer: Vec<u8>,
    /// Parts going up, oldest first; `progress.parts` has those before.
    sending: VecDeque<PartSent<'a>>,
}

impl<'a, S: BlobStore> Writer<'a, S> {
    /// Picks up where the last request left off, the tail read back.
    pub async fn resume(store: &'a S, progress: Progress) -> Result<Writer<'a, S>> {
        let buffer = if progress.tail > 0 {
            let tail = store.read(&tail_key(&progress.id)).await?.unwrap_or_default();
            if tail.len() as u64 != progress.tail {
                return Err(worker::Error::RustError(format!("upload {} lost its last {} bytes", progress.id, progress.tail)));
            }
            tail
        } else {
            Vec::with_capacity(64 * 1024)
        };
        Ok(Writer { store, progress, buffer, sending: VecDeque::new() })
    }

    /// Bytes received so far, over every request.
    pub fn received(&self) -> u64 {
        self.progress.offset
    }

    pub async fn write(&mut self, chunk: &[u8]) -> Result<()> {
        self.progress.hasher.update(chunk);
        self.progress.offset += chunk.len() as u64;
        self.buffer.extend_from_slice(chunk);
        let (whole, _) = whole_parts(self.buffer.len(), PART_BYTES);
        for _ in 0..whole {
            let rest = self.buffer.split_off(PART_BYTES);
            let part = std::mem::replace(&mut self.buffer, rest);
            self.send_part(part).await?;
        }
        Ok(())
    }

    async fn send_part(&mut self, bytes: Vec<u8>) -> Result<()> {
        let key = parts_key(&self.progress.id);
        let upload_id = match &self.progress.multipart_id {
            Some(id) => id.clone(),
            None => {
                let id = self.store.create_multipart(&key).await?;
                self.progress.multipart_id = Some(id.clone());
                id
            }
        };
        // Room for it first: the oldest part going up is waited for.
        while !may_send(self.sending.len(), SENDING.with(Cell::get)) {
            self.settle_oldest().await?;
        }
        let number = (self.progress.parts.len() + self.sending.len() + 1) as u16;
        let store = self.store;
        let counted = Sending::start();
        let mut sent: PartSent<'a> = Box::pin(async move {
            let _counted = counted;
            store.upload_part(&key, &upload_id, number, bytes).await
        });
        // Started now, and left to finish while the next bytes are read.
        if let Some(done) = poll_once(&mut sent).await {
            sent = Box::pin(std::future::ready(done));
        }
        self.sending.push_back(sent);
        Ok(())
    }

    /// Waits for the oldest part going up, and keeps what the store made
    /// of it.
    async fn settle_oldest(&mut self) -> Result<()> {
        if let Some(sent) = self.sending.pop_front() {
            self.progress.parts.push(sent.await?);
        }
        Ok(())
    }

    /// Waits for every part going up, in order. On a failure the rest are
    /// still waited for by `abandon`, so none is left going up.
    async fn settle(&mut self) -> Result<()> {
        while !self.sending.is_empty() {
            self.settle_oldest().await?;
        }
        Ok(())
    }

    /// Waits for every part going up, whatever becomes of them.
    async fn let_settle(&mut self) {
        while let Some(sent) = self.sending.pop_front() {
            if let Ok(part) = sent.await {
                self.progress.parts.push(part);
            }
        }
    }

    /// Ends this request: what is left is kept as the tail, and the
    /// progress comes back to be saved. If the tail cannot be kept, the
    /// upload is let go, so nothing it stored is left behind.
    pub async fn pause(mut self) -> Result<Progress> {
        if let Err(error) = self.settle().await {
            let _ = self.abandon().await;
            return Err(error);
        }
        let Writer { store, mut progress, buffer, .. } = self;
        let key = tail_key(&progress.id);
        let kept = if buffer.is_empty() {
            if progress.tail > 0 { store.delete(&key).await } else { Ok(()) }
        } else {
            store.put(&key, buffer.clone()).await
        };
        if let Err(error) = kept {
            let _ = abort(store, &progress).await;
            return Err(error);
        }
        progress.tail = buffer.len() as u64;
        Ok(progress)
    }

    /// Gives the upload up part way: a refused or failed request. Everything
    /// it stored goes, the parts this request sent included.
    pub async fn abandon(mut self) -> Result<()> {
        // A part still going up would outlive the abort, and be kept.
        self.let_settle().await;
        abort(self.store, &self.progress).await
    }

    /// Ends the upload. `stored` says the blob with the expected digest is
    /// already kept, so these bytes are only checked and let go. If storing
    /// fails, what the upload stored is let go before the error is given.
    pub async fn finish(mut self, expected: &Digest, stored: bool) -> Result<Finished> {
        if let Err(error) = self.settle().await {
            let _ = self.abandon().await;
            return Err(error);
        }
        let store = self.store;
        let progress = self.progress.clone();
        match self.finish_inner(expected, stored).await {
            Ok(finished) => Ok(finished),
            Err(error) => {
                let _ = abort(store, &progress).await;
                Err(error)
            }
        }
    }

    async fn finish_inner(self, expected: &Digest, stored: bool) -> Result<Finished> {
        let Writer { store, progress, buffer, .. } = self;
        let size = progress.offset;
        let actual = progress.hasher.clone().finish();
        if &actual != expected || stored {
            abort(store, &progress).await?;
            return Ok(if &actual != expected { Finished::Mismatch { actual } } else { Finished::Duplicate { size } });
        }
        let key = match &progress.multipart_id {
            None => {
                let key = expected.object_key();
                store.put(&key, buffer).await?;
                key
            }
            Some(upload_id) => {
                let key = parts_key(&progress.id);
                let mut parts = progress.parts.clone();
                if !buffer.is_empty() {
                    let number = parts.len() as u16 + 1;
                    parts.push(store.upload_part(&key, upload_id, number, buffer).await?);
                }
                store.complete_multipart(&key, upload_id, &parts).await?;
                key
            }
        };
        if progress.tail > 0 {
            store.delete(&tail_key(&progress.id)).await?;
        }
        Ok(Finished::Stored { key, size })
    }
}

/// What letting go of an unfinished upload takes.
#[derive(Debug, PartialEq, Eq)]
pub struct Cleanup {
    /// The multipart upload to abort, by its key and id: started by this
    /// request or an earlier one.
    pub multipart: Option<(String, String)>,
    /// The tail kept between requests, to delete.
    pub tail: Option<String>,
}

/// What an unfinished upload has stored, from its progress as it stands.
/// A tail is only ever written when a request pauses, so `progress.tail`
/// says whether one is there whatever the current request did.
pub fn cleanup(progress: &Progress) -> Cleanup {
    Cleanup {
        multipart: progress.multipart_id.as_ref().map(|id| (parts_key(&progress.id), id.clone())),
        tail: (progress.tail > 0).then(|| tail_key(&progress.id)),
    }
}

/// Lets go of everything an unfinished upload stored. Both steps are tried
/// even when one fails.
pub async fn abort<S: BlobStore>(store: &S, progress: &Progress) -> Result<()> {
    let Cleanup { multipart, tail } = cleanup(progress);
    let aborted = match &multipart {
        Some((key, id)) => store.abort_multipart(key, id).await,
        None => Ok(()),
    };
    let deleted = match &tail {
        Some(key) => store.delete(key).await,
        None => Ok(()),
    };
    aborted.and(deleted)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bytes_make_whole_parts_and_a_tail() {
        assert_eq!(whole_parts(0, PART_BYTES), (0, 0));
        assert_eq!(whole_parts(PART_BYTES - 1, PART_BYTES), (0, PART_BYTES - 1));
        assert_eq!(whole_parts(PART_BYTES, PART_BYTES), (1, 0));
        assert_eq!(whole_parts(2 * PART_BYTES + 5, PART_BYTES), (2, 5));
        const { assert!(PART_BYTES >= 5 * 1024 * 1024, "R2's least part") };
    }

    use std::cell::RefCell;
    use std::collections::HashMap;
    use std::future::Future;
    use std::pin::pin;
    use std::task::{Context, Poll, Waker};

    use worker::ResponseBody;

    use crate::range::Wanted;
    use crate::store::Got;

    /// Multipart uploads in progress, by id: their parts so far.
    type Uploads = HashMap<String, Vec<(u16, Vec<u8>)>>;

    /// A store in memory that keeps multipart uploads the way R2 does,
    /// refusing parts of different sizes.
    #[derive(Default)]
    struct Memory {
        objects: RefCell<HashMap<String, Vec<u8>>>,
        parts: RefCell<Uploads>,
        puts: RefCell<u32>,
    }

    impl BlobStore for Memory {
        async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
            *self.puts.borrow_mut() += 1;
            self.objects.borrow_mut().insert(key.to_owned(), bytes);
            Ok(())
        }
        async fn get(&self, key: &str, _range: Option<Wanted>) -> Result<Option<Got>> {
            Ok(self.objects.borrow().get(key).map(|b| Got { size: b.len() as u64, body: ResponseBody::Body(b.clone()) }))
        }
        async fn head(&self, key: &str) -> Result<Option<u64>> {
            Ok(self.objects.borrow().get(key).map(|b| b.len() as u64))
        }
        async fn delete(&self, key: &str) -> Result<()> {
            self.objects.borrow_mut().remove(key);
            Ok(())
        }
        async fn create_multipart(&self, key: &str) -> Result<String> {
            self.parts.borrow_mut().insert(format!("mp-{key}"), Vec::new());
            Ok(format!("mp-{key}"))
        }
        async fn upload_part(&self, _key: &str, upload_id: &str, number: u16, bytes: Vec<u8>) -> Result<Part> {
            self.parts.borrow_mut().get_mut(upload_id).expect("started").push((number, bytes));
            Ok(Part { number, etag: format!("e{number}") })
        }
        async fn complete_multipart(&self, key: &str, upload_id: &str, parts: &[Part]) -> Result<()> {
            let mut uploaded = self.parts.borrow_mut().remove(upload_id).expect("started");
            assert_eq!(uploaded.len(), parts.len());
            // Parts may arrive in any order; they are joined by number, as R2 does.
            uploaded.sort_by_key(|(number, _)| *number);
            let numbers: Vec<u16> = parts.iter().map(|part| part.number).collect();
            assert_eq!(numbers, (1..=parts.len() as u16).collect::<Vec<_>>(), "the parts are named in order");
            let sizes: Vec<usize> = uploaded.iter().map(|(_, b)| b.len()).collect();
            if let Some((_, rest)) = sizes.split_last() {
                assert!(rest.iter().all(|size| *size == PART_BYTES), "every part but the last is the same size: {sizes:?}");
            }
            let joined = uploaded.into_iter().flat_map(|(_, b)| b).collect();
            self.objects.borrow_mut().insert(key.to_owned(), joined);
            Ok(())
        }
        async fn abort_multipart(&self, _key: &str, upload_id: &str) -> Result<()> {
            self.parts.borrow_mut().remove(upload_id);
            Ok(())
        }
        fn presign_get(&self, _key: &str, _expires: u32, _now_ms: u64) -> Option<String> {
            None
        }
    }

    /// Runs a future that never waits on anything outside memory.
    fn run<F: Future>(future: F) -> F::Output {
        let mut future = pin!(future);
        match future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
            Poll::Ready(output) => output,
            Poll::Pending => panic!("the in-memory store never waits"),
        }
    }

    fn bytes(length: usize) -> Vec<u8> {
        (0..length).map(|i| (i * 31 % 251) as u8).collect()
    }

    /// Sends `data` in `requests`, each cut into the chunks given, pausing
    /// and saving the progress (hasher state too) between requests.
    fn upload(store: &Memory, data: &[u8], requests: &[&[usize]]) -> Finished {
        let mut progress = Progress::new("upl_1");
        let mut at = 0;
        for chunks in requests {
            let mut writer = run(Writer::resume(store, progress)).unwrap();
            for size in *chunks {
                let end = (at + size).min(data.len());
                run(writer.write(&data[at..end])).unwrap();
                at = end;
            }
            progress = run(writer.pause()).unwrap();
            let text = serde_json::to_string(&progress).unwrap();
            let saved = progress.hasher.save();
            progress = serde_json::from_str(&text).unwrap();
            progress.hasher = Sha256::restore(&saved).unwrap();
        }
        assert_eq!(at, data.len());
        let writer = run(Writer::resume(store, progress)).unwrap();
        run(writer.finish(&Digest::of(data), false)).unwrap()
    }

    #[test]
    fn a_small_blob_is_stored_whole_at_its_digest() {
        let store = Memory::default();
        let data = bytes(100_000);
        let finished = upload(&store, &data, &[&[1000, 4000], &[95_000]]);
        let key = Digest::of(&data).object_key();
        assert_eq!(finished, Finished::Stored { key: key.clone(), size: 100_000 });
        assert_eq!(store.objects.borrow()[&key], data);
        assert!(!store.objects.borrow().contains_key(&tail_key("upl_1")), "the tail is let go");
    }

    #[test]
    fn chunks_of_any_size_become_parts_of_one_size() {
        let store = Memory::default();
        let data = bytes(2 * PART_BYTES + 12_345);
        // Uneven chunks over three requests, one ending inside a part.
        let finished = upload(&store, &data, &[&[3 * 1024 * 1024, 9 * 1024 * 1024], &[700_000], &[PART_BYTES * 2]]);
        let key = parts_key("upl_1");
        assert_eq!(finished, Finished::Stored { key: key.clone(), size: data.len() as u64 });
        assert_eq!(store.objects.borrow()[&key], data);
        assert_eq!(store.objects.borrow().len(), 1, "nothing else is left behind");
    }

    #[test]
    fn a_wrong_digest_or_a_blob_already_kept_lets_the_bytes_go() {
        let store = Memory::default();
        let data = bytes(PART_BYTES + 10);
        let mut writer = run(Writer::resume(&store, Progress::new("upl_2"))).unwrap();
        run(writer.write(&data)).unwrap();
        let finished = run(writer.finish(&Digest::of(b"something else"), false)).unwrap();
        assert_eq!(finished, Finished::Mismatch { actual: Digest::of(&data) });
        assert!(store.parts.borrow().is_empty(), "the multipart upload is aborted");
        let mut writer = run(Writer::resume(&store, Progress::new("upl_3"))).unwrap();
        run(writer.write(&data[..10])).unwrap();
        assert_eq!(run(writer.finish(&Digest::of(&data[..10]), true)).unwrap(), Finished::Duplicate { size: 10 });
        assert!(store.objects.borrow().is_empty());
    }

    #[test]
    fn letting_go_takes_the_multipart_and_the_tail_there_are() {
        let mut progress = Progress::new("upl_9");
        assert_eq!(cleanup(&progress), Cleanup { multipart: None, tail: None });
        progress.tail = 5;
        assert_eq!(cleanup(&progress), Cleanup { multipart: None, tail: Some(tail_key("upl_9")) });
        progress.multipart_id = Some("mp".into());
        progress.tail = 0;
        assert_eq!(cleanup(&progress), Cleanup { multipart: Some((parts_key("upl_9"), "mp".into())), tail: None });
    }

    #[test]
    fn a_request_given_up_part_way_leaves_nothing_behind() {
        let store = Memory::default();
        let data = bytes(PART_BYTES + 100);
        // An earlier request left a tail.
        let mut writer = run(Writer::resume(&store, Progress::new("upl_4"))).unwrap();
        run(writer.write(&data[..100])).unwrap();
        let progress = run(writer.pause()).unwrap();
        assert!(store.objects.borrow().contains_key(&tail_key("upl_4")));
        // This one starts the multipart upload, then is refused.
        let mut writer = run(Writer::resume(&store, progress)).unwrap();
        run(writer.write(&data[100..])).unwrap();
        assert_eq!(store.parts.borrow().len(), 1, "a part went up");
        run(writer.abandon()).unwrap();
        assert!(store.parts.borrow().is_empty(), "the multipart upload is aborted");
        assert!(store.objects.borrow().is_empty(), "the tail is deleted");
    }

    #[test]
    fn progress_round_trips_without_its_hasher() {
        let mut progress = Progress::new("upl_1");
        progress.parts.push(Part { number: 1, etag: "\"e1\"".into() });
        progress.offset = 42;
        let text = serde_json::to_string(&progress).unwrap();
        let back: Progress = serde_json::from_str(&text).unwrap();
        assert_eq!(back.parts, progress.parts);
        assert_eq!(back.offset, 42);
        assert_eq!(parts_key("upl_1"), "blobs/parts/upl_1");
        assert_eq!(tail_key("upl_1"), "uploads/upl_1/tail");
    }

    /// A store whose parts each take a while to go up: every part waits
    /// `polls` turns before the store has it, and the most going up at once
    /// is counted.
    struct Slow {
        memory: Memory,
        polls: usize,
        going: Cell<usize>,
        most: Cell<usize>,
    }

    /// Pending `turns` times, then ready.
    async fn turns(mut turns: usize) {
        poll_fn(|cx| {
            if turns == 0 {
                return Poll::Ready(());
            }
            turns -= 1;
            cx.waker().wake_by_ref();
            Poll::Pending
        })
        .await
    }

    impl BlobStore for Slow {
        async fn put(&self, key: &str, bytes: Vec<u8>) -> Result<()> {
            self.memory.put(key, bytes).await
        }
        async fn get(&self, key: &str, range: Option<Wanted>) -> Result<Option<Got>> {
            self.memory.get(key, range).await
        }
        async fn head(&self, key: &str) -> Result<Option<u64>> {
            self.memory.head(key).await
        }
        async fn delete(&self, key: &str) -> Result<()> {
            self.memory.delete(key).await
        }
        async fn create_multipart(&self, key: &str) -> Result<String> {
            self.memory.create_multipart(key).await
        }
        async fn upload_part(&self, key: &str, upload_id: &str, number: u16, bytes: Vec<u8>) -> Result<Part> {
            self.going.set(self.going.get() + 1);
            self.most.set(self.most.get().max(self.going.get()));
            turns(self.polls).await;
            self.going.set(self.going.get() - 1);
            self.memory.upload_part(key, upload_id, number, bytes).await
        }
        async fn complete_multipart(&self, key: &str, upload_id: &str, parts: &[Part]) -> Result<()> {
            self.memory.complete_multipart(key, upload_id, parts).await
        }
        async fn abort_multipart(&self, key: &str, upload_id: &str) -> Result<()> {
            self.memory.abort_multipart(key, upload_id).await
        }
        fn presign_get(&self, _key: &str, _expires: u32, _now_ms: u64) -> Option<String> {
            None
        }
    }

    /// Runs a future to its end, however often it waits.
    fn block_on<F: Future>(future: F) -> F::Output {
        let mut future = pin!(future);
        loop {
            if let Poll::Ready(output) = future.as_mut().poll(&mut Context::from_waker(Waker::noop())) {
                return output;
            }
        }
    }

    #[test]
    fn parts_go_up_while_the_next_bytes_are_read_a_few_at_once() {
        let store = Slow { memory: Memory::default(), polls: 3, going: Cell::new(0), most: Cell::new(0) };
        let data = bytes(5 * PART_BYTES + 77);
        let mut writer = block_on(Writer::resume(&store, Progress::new("upl_5"))).unwrap();
        for piece in data.chunks(PART_BYTES / 2) {
            block_on(writer.write(piece)).unwrap();
        }
        assert!(store.going.get() > 0, "parts are still going up as the request reads on");
        let progress = block_on(writer.pause()).unwrap();
        assert_eq!(store.going.get(), 0, "a paused request has every part in");
        assert_eq!(store.most.get(), PARTS_IN_FLIGHT, "no more than {PARTS_IN_FLIGHT} at once");
        assert_eq!(progress.parts.iter().map(|p| p.number).collect::<Vec<_>>(), vec![1, 2, 3, 4, 5]);
        assert_eq!(progress.tail, 77);
        let writer = block_on(Writer::resume(&store, progress)).unwrap();
        let finished = block_on(writer.finish(&Digest::of(&data), false)).unwrap();
        assert_eq!(finished, Finished::Stored { key: parts_key("upl_5"), size: data.len() as u64 });
        assert_eq!(store.memory.objects.borrow()[&parts_key("upl_5")], data, "joined in order");
        assert_eq!(SENDING.with(Cell::get), 0, "every part counted is let go");
    }

    #[test]
    fn a_request_given_up_with_parts_going_up_waits_for_them_and_leaves_nothing() {
        let store = Slow { memory: Memory::default(), polls: 2, going: Cell::new(0), most: Cell::new(0) };
        let data = bytes(2 * PART_BYTES);
        let mut writer = block_on(Writer::resume(&store, Progress::new("upl_6"))).unwrap();
        block_on(writer.write(&data)).unwrap();
        assert!(store.going.get() > 0);
        block_on(writer.abandon()).unwrap();
        assert_eq!(store.going.get(), 0, "nothing is left going up after the abort");
        assert!(store.memory.parts.borrow().is_empty(), "the multipart upload is aborted");
    }

    #[test]
    fn a_request_sends_its_first_part_always_and_more_while_the_worker_has_room() {
        assert!(may_send(0, ISOLATE_PARTS + 10), "its first part goes however busy the Worker is");
        assert!(may_send(1, 0));
        assert!(may_send(PARTS_IN_FLIGHT - 1, ISOLATE_PARTS - 1));
        assert!(!may_send(PARTS_IN_FLIGHT, 0), "no more than {PARTS_IN_FLIGHT} of its own");
        assert!(!may_send(1, ISOLATE_PARTS), "no more than {ISOLATE_PARTS} across the Worker beyond each first");
    }
}
