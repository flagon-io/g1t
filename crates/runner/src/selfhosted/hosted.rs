//! g1t's machine image on this runner: the image jobs asking for one of
//! g1t's machines (`ubuntu-latest`) run in (`exec::job_image`), published
//! at g1t.sh/flagon-io/g1t-hosted with each runner release
//! (scripts/hosted-image.mjs) and given to the sandbox's runner by the
//! launcher. It is large (5.6 GB unpacked), so the runner pulls it once, in
//! the background, as it starts, and tells g1t it has it (`hosted_image`
//! in each poll) only once it is here: until then, g1t runs those jobs on
//! its own machines, and no job waits on the pull. A job that finds it gone
//! anyway (removed by hand) pulls it as it starts, and "Set up job" says
//! why it took so long.

use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use super::log;

/// Its size unpacked, as the sandbox's release says (`G1T_HOSTED_IMAGE_SIZE`),
/// for the words on pulling it.
pub fn size_from_env() -> Option<u64> {
    std::env::var(super::exec::HOSTED_IMAGE_SIZE_ENV).ok().and_then(|size| size.trim().parse().ok()).filter(|size| *size > 0)
}

/// `Pulling g1t's machine image (5.6 GB, once)`.
pub fn pulling_said(size: Option<u64>) -> String {
    match size {
        Some(bytes) => format!("Pulling g1t's machine image ({:.1} GB, once)", bytes as f64 / 1e9),
        None => "Pulling g1t's machine image (once)".to_owned(),
    }
}

/// What "Set up job" says of a job that pulled the image as it started.
pub fn pulled_in_job(size: Option<u64>) -> String {
    format!("{} before this job started: this runner didn't have it yet, so the job waited for it.", pulling_said(size))
}

/// Whether Docker has `image` here.
pub fn present(image: &str) -> bool {
    super::exec::docker()
        .args(["image", "inspect", "--format", "{{.Id}}", image])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|s| s.success())
}

/// The repository of an image reference: without its tag or digest.
#[cfg_attr(not(unix), allow(dead_code))]
fn repository(image: &str) -> &str {
    let image = image.split('@').next().unwrap_or(image);
    match image.rfind(':') {
        // A colon after the last slash is a tag's; before it, a port's.
        Some(colon) if !image[colon..].contains('/') => &image[..colon],
        _ => image,
    }
}

/// Removes the other versions of g1t's machine image from the runner's own
/// engine, each 5.6 GB, once the current one is here. Never on a Docker the
/// runner shares with the machine, whose images aren't its to remove.
fn prune_others(image: &str) {
    #[cfg(unix)]
    if super::engine::in_use() {
        let repo = repository(image);
        let listed = super::exec::docker().args(["image", "ls", "--no-trunc", "--format", "{{.ID}}", repo]).output();
        let Ok(listed) = listed else { return };
        let keep = super::exec::docker()
            .args(["image", "inspect", "--format", "{{.Id}}", image])
            .output()
            .ok()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_owned());
        for id in String::from_utf8_lossy(&listed.stdout).lines().map(str::trim).filter(|id| !id.is_empty()) {
            if Some(id) != keep.as_deref() {
                let _ = super::exec::docker().args(["image", "rm", id]).stdout(Stdio::null()).stderr(Stdio::null()).status();
            }
        }
    }
    #[cfg(not(unix))]
    let _ = image;
}

/// Whether g1t's machine image is here, pulled in the background.
#[derive(Clone)]
pub struct Ready(Arc<AtomicBool>);

impl Ready {
    /// Already here, or never asked for.
    pub fn now(ready: bool) -> Ready {
        Ready(Arc::new(AtomicBool::new(ready)))
    }

    /// Starts pulling `image` unless it is here, trying again (a minute,
    /// doubling to fifteen) until it is.
    pub fn start(image: &str, size: Option<u64>) -> Ready {
        if present(image) {
            prune_others(image);
            return Ready::now(true);
        }
        let ready = Ready::now(false);
        let flag = ready.0.clone();
        let image = image.to_owned();
        std::thread::spawn(move || {
            log(&format!("{} from {image}. Until it's here, g1t runs jobs asking for its machines on its own.", pulling_said(size)));
            let mut wait = Duration::from_secs(60);
            loop {
                let started = Instant::now();
                let pulled = super::exec::docker()
                    .args(["pull", "-q", &image])
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::piped())
                    .output();
                match pulled {
                    Ok(out) if out.status.success() || present(&image) => {
                        log(&format!(
                            "Pulled g1t's machine image in {}: this runner takes jobs asking for g1t's machines now.",
                            took(started.elapsed())
                        ));
                        flag.store(true, Ordering::SeqCst);
                        prune_others(&image);
                        return;
                    }
                    Ok(out) => log(&format!(
                        "Could not pull g1t's machine image ({}); trying again in {} min.",
                        String::from_utf8_lossy(&out.stderr).trim(),
                        wait.as_secs() / 60
                    )),
                    Err(error) => log(&format!(
                        "Could not run docker to pull g1t's machine image ({error}); trying again in {} min.",
                        wait.as_secs() / 60
                    )),
                }
                std::thread::sleep(wait);
                wait = (wait * 2).min(Duration::from_secs(15 * 60));
            }
        });
        ready
    }

    pub fn ready(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

/// `4m 12s`.
fn took(elapsed: Duration) -> String {
    let seconds = elapsed.as_secs();
    if seconds >= 60 { format!("{}m {}s", seconds / 60, seconds % 60) } else { format!("{seconds}s") }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pulling_it_says_how_big_it_is_and_that_it_is_once() {
        assert_eq!(pulling_said(Some(5_636_544_756)), "Pulling g1t's machine image (5.6 GB, once)");
        assert_eq!(pulling_said(None), "Pulling g1t's machine image (once)");
        assert!(pulled_in_job(Some(5_636_544_756)).starts_with("Pulling g1t's machine image (5.6 GB, once) before this job started"));
        assert_eq!(took(Duration::from_secs(252)), "4m 12s");
        assert_eq!(took(Duration::from_secs(9)), "9s");
    }

    #[test]
    fn an_images_repository_is_without_its_tag_or_digest() {
        assert_eq!(repository("g1t.sh/flagon-io/g1t-hosted@sha256:d5"), "g1t.sh/flagon-io/g1t-hosted");
        assert_eq!(repository("g1t.sh/flagon-io/g1t-hosted:base-1@sha256:d5"), "g1t.sh/flagon-io/g1t-hosted");
        assert_eq!(repository("localhost:5000/hosted"), "localhost:5000/hosted");
        assert_eq!(repository("localhost:5000/hosted:1"), "localhost:5000/hosted");
    }

    #[test]
    fn a_runner_not_asked_for_it_or_with_it_here_is_ready() {
        assert!(Ready::now(true).ready());
        assert!(!Ready::now(false).ready());
    }
}
