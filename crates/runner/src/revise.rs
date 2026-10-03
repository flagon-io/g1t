//! Sends the author back to a pull request that is already ready for
//! review, to address what its acceptance checks or a review found.
//!
//! The work is the same as making the change in the first place (see
//! `main`): clone the fork, run the agent on `PROMPT`, commit and push.
//! What differs is the ending. The pull request stays as it is, with the
//! agent's account of what it changed added to its session, and a failure
//! leaves it open for a person to look at.

use crate::report::{Entry, Reporter};

pub fn main() -> i32 {
    let mut reporter = match Reporter::from_env() {
        Ok(reporter) => reporter,
        Err(error) => {
            eprintln!("g1t-runner: {error:#}");
            return 2;
        }
    };
    let outcome = crate::run(&mut reporter);
    // On success the agent's account is already in the session: the harness
    // records its messages as they arrive.
    if let Err(error) = &outcome {
        eprintln!("g1t-runner: {error:#}");
        reporter.record(Entry::new(
            "note",
            &format!("The revision failed: {error:#}. Nothing was pushed."),
        ));
    }
    reporter.flush();
    i32::from(outcome.is_err())
}
