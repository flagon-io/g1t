//! Fitting events into queue messages, and batches into `sendBatch` calls.
//!
//! A queue takes up to 100 messages and 256 KB in one `sendBatch`, and up
//! to 128 KB in one message. Batches are cut by count and by size, with
//! room to spare for how the runtime encodes them. An event too large for
//! one message has its long text shortened and is marked `truncated`:
//! whoever needs the whole text reads it from the service that owns it.

use g1t_contracts::events::Event;
use serde_json::Value;

/// The most messages in one `sendBatch`.
pub const MAX_BATCH_MESSAGES: usize = 100;
/// The most bytes of JSON in one `sendBatch`, under the queue's 256 KB.
pub const MAX_BATCH_BYTES: usize = 200 * 1024;
/// The most bytes of JSON in one message, under the queue's 128 KB.
pub const MAX_MESSAGE_BYTES: usize = 96 * 1024;
/// The key set in `data` on an event whose long text was shortened.
pub const TRUNCATED: &str = "truncated";
/// How long text is cut to, longest first, until the event fits. Ids and
/// names are shorter than the last, so they are never cut.
const CUTS: [usize; 3] = [4096, 512, 128];

/// An event's size as JSON.
pub fn size(event: &Event) -> usize {
    serde_json::to_string(event).map_or(usize::MAX, |json| json.len())
}

/// Shortens `event`'s long strings until it fits in one message, and marks
/// it truncated if anything was cut. Ids, numbers and short fields stay, so
/// every consumer still knows what the event is about.
pub fn fit(event: &mut Event) {
    if size(event) <= MAX_MESSAGE_BYTES {
        return;
    }
    for cut in CUTS {
        shorten(&mut event.data, cut);
        mark(&mut event.data);
        if size(event) <= MAX_MESSAGE_BYTES {
            return;
        }
    }
    // Still too large (a long list, say): only the top level's short
    // values are kept.
    let kept = match &event.data {
        Value::Object(map) => map
            .iter()
            .filter(|(_, value)| matches!(value, Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Null))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect(),
        _ => serde_json::Map::new(),
    };
    event.data = Value::Object(kept);
    mark(&mut event.data);
}

fn shorten(value: &mut Value, cut: usize) {
    match value {
        Value::String(text) if text.len() > cut => {
            let end = (0..=cut).rev().find(|end| text.is_char_boundary(*end)).unwrap_or(0);
            text.truncate(end);
        }
        Value::Array(items) => items.iter_mut().for_each(|item| shorten(item, cut)),
        Value::Object(map) => map.values_mut().for_each(|item| shorten(item, cut)),
        _ => {}
    }
}

fn mark(data: &mut Value) {
    if let Value::Object(map) = data {
        map.insert(TRUNCATED.to_owned(), Value::Bool(true));
    }
}

/// `events` cut into `sendBatch` calls, in order: no more than
/// [`MAX_BATCH_MESSAGES`] and [`MAX_BATCH_BYTES`] each. Events are expected
/// to have been [`fit`].
pub fn chunks<'a>(events: &[&'a Event]) -> Vec<Vec<&'a Event>> {
    let mut chunks: Vec<Vec<&Event>> = Vec::new();
    let mut bytes = 0;
    for event in events {
        let event_bytes = size(event);
        let full = chunks
            .last()
            .is_none_or(|chunk| chunk.len() >= MAX_BATCH_MESSAGES || bytes + event_bytes > MAX_BATCH_BYTES);
        if full {
            chunks.push(Vec::new());
            bytes = 0;
        }
        chunks.last_mut().expect("just pushed").push(event);
        bytes += event_bytes;
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn event(data: Value) -> Event {
        Event {
            id: "evt_1".into(),
            kind: "comment.edited".into(),
            source: "work".into(),
            time: "2026-10-08T00:00:00Z".into(),
            repo_id: Some("rep_1".into()),
            actor: Some("usr_1".into()),
            data,
        }
    }

    #[test]
    fn a_small_event_is_left_as_it_is() {
        let mut small = event(json!({ "number": 4, "changes": { "body": { "from": "hello" } } }));
        fit(&mut small);
        assert_eq!(small.data, json!({ "number": 4, "changes": { "body": { "from": "hello" } } }));
    }

    #[test]
    fn a_large_event_keeps_its_shape_and_ids_with_its_text_shortened() {
        let mut large = event(json!({
            "commentId": "cmt_1",
            "number": 4,
            "comment": { "body": "é".repeat(100_000), "author": "ana" },
        }));
        fit(&mut large);
        assert!(size(&large) <= MAX_MESSAGE_BYTES);
        assert_eq!(large.data[TRUNCATED], true);
        assert_eq!(large.data["commentId"], "cmt_1");
        assert_eq!(large.data["number"], 4);
        // Still an object, so whoever reads its fields still can.
        assert_eq!(large.data["comment"]["author"], "ana");
        assert!(large.data["comment"]["body"].as_str().unwrap().len() <= 4096);
    }

    #[test]
    fn an_event_too_large_even_shortened_keeps_its_top_level_values() {
        let many: Vec<Value> = (0..20_000).map(|n| json!({ "n": n })).collect();
        let mut huge = event(json!({ "pullId": "pul_1", "files": many }));
        fit(&mut huge);
        assert!(size(&huge) <= MAX_MESSAGE_BYTES);
        assert_eq!(huge.data, json!({ "pullId": "pul_1", "truncated": true }));
    }

    #[test]
    fn batches_are_cut_by_count_and_by_size() {
        let small: Vec<Event> = (0..250).map(|_| event(json!({ "number": 1 }))).collect();
        let refs: Vec<&Event> = small.iter().collect();
        let counted: Vec<usize> = chunks(&refs).iter().map(Vec::len).collect();
        assert_eq!(counted, [100, 100, 50]);

        let big: Vec<Event> = (0..5).map(|_| event(json!({ "text": "x".repeat(80 * 1024) }))).collect();
        let refs: Vec<&Event> = big.iter().collect();
        let cut = chunks(&refs);
        assert_eq!(cut.iter().map(Vec::len).collect::<Vec<_>>(), [2, 2, 1]);
        for chunk in cut {
            assert!(chunk.iter().map(|event| size(event)).sum::<usize>() <= MAX_BATCH_BYTES);
        }
        assert!(chunks(&[]).is_empty());
    }
}
