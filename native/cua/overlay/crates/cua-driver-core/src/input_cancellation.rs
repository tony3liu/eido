//! Request-owned cooperative input cancellation. Blocking workers retain the
//! signal; cancelling a future never grants the next worker its authority.

use std::cell::RefCell;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

#[derive(Default)]
struct State {
    cancelled: AtomicBool,
    posted: AtomicUsize,
    wake: Condvar,
    wait: Mutex<()>,
}

#[derive(Clone, Default)]
pub struct InputCancellation {
    state: Arc<State>,
    session: Option<String>,
}

#[derive(Debug)]
pub struct InputInterrupted {
    /// Characters posted, not independently confirmed by the application.
    pub posted_chars: usize,
    pub reason: &'static str,
}
impl std::fmt::Display for InputInterrupted {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "input stopped ({}) after {} posted character(s)",
            self.reason, self.posted_chars
        )
    }
}
impl std::error::Error for InputInterrupted {}

tokio::task_local! { pub static REQUEST_INPUT: InputCancellation; }
thread_local! { static BLOCKING_INPUT: RefCell<Option<InputCancellation>> = const { RefCell::new(None) }; }

pub struct CancelOnDrop(InputCancellation);
impl Drop for CancelOnDrop {
    fn drop(&mut self) {
        self.0.cancel();
    }
}

impl InputCancellation {
    pub fn current(session: Option<String>) -> Self {
        let mut signal = REQUEST_INPUT.try_with(Clone::clone).unwrap_or_default();
        signal.session = session;
        signal
    }
    pub fn cancel_on_drop(&self) -> CancelOnDrop {
        CancelOnDrop(self.clone())
    }
    pub fn cancel(&self) {
        // Synchronize with the wait predicate so notification cannot be lost
        // between checking the flag and entering the condition-variable wait.
        let _guard = self.state.wait.lock().unwrap();
        self.state.cancelled.store(true, Ordering::Release);
        self.state.wake.notify_all();
    }
    pub fn is_cancelled(&self) -> bool {
        self.state.cancelled.load(Ordering::Acquire)
            || self
                .session
                .as_deref()
                .is_some_and(crate::session::is_session_ending)
    }
    pub fn check(&self) -> Result<(), InputInterrupted> {
        if self.is_cancelled() {
            Err(InputInterrupted {
                posted_chars: self.state.posted.load(Ordering::Acquire),
                reason: "request_or_session_ended",
            })
        } else {
            Ok(())
        }
    }
    pub fn wait(&self, duration: Duration) {
        let deadline = Instant::now() + duration;
        let mut guard = self.state.wait.lock().unwrap();
        while !self.is_cancelled() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            // Session termination is a separate lifecycle signal. Poll it at
            // most every 10ms even when no request notification is available.
            guard = self
                .state
                .wake
                .wait_timeout(guard, remaining.min(Duration::from_millis(10)))
                .unwrap()
                .0;
        }
    }
}

pub fn with_blocking<T>(signal: InputCancellation, work: impl FnOnce() -> T) -> T {
    struct Restore(Option<InputCancellation>);
    impl Drop for Restore {
        fn drop(&mut self) {
            BLOCKING_INPUT.with(|slot| *slot.borrow_mut() = self.0.take());
        }
    }
    let _restore = Restore(BLOCKING_INPUT.with(|slot| slot.replace(Some(signal))));
    work()
}
pub fn check() -> Result<(), InputInterrupted> {
    BLOCKING_INPUT.with(|slot| {
        slot.borrow()
            .as_ref()
            .map_or(Ok(()), InputCancellation::check)
    })
}

/// A platform may revoke its foreground route when the user selects another
/// application. This reports posted input without affecting sibling requests.
pub fn interrupted(reason: &'static str) -> InputInterrupted {
    BLOCKING_INPUT.with(|slot| InputInterrupted {
        posted_chars: slot.borrow().as_ref().map_or(0, |signal| signal.state.posted.load(Ordering::Acquire)),
        reason,
    })
}
/// Wakes early on cancel, but callers must still release an already-held key.
pub fn wait(duration: Duration) {
    BLOCKING_INPUT.with(|slot| match slot.borrow().as_ref() {
        Some(signal) => signal.wait(duration),
        None => std::thread::sleep(duration),
    });
}
pub fn note_character() {
    BLOCKING_INPUT.with(|slot| {
        if let Some(signal) = slot.borrow().as_ref() {
            signal.state.posted.fetch_add(1, Ordering::AcqRel);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancellation_wakes_pacing_and_stops_before_the_next_character() {
        let signal = InputCancellation::default();
        let worker_signal = signal.clone();
        let (tx, rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            with_blocking(worker_signal, || {
                let mut transitions = Vec::new();
                for character in "abc".chars() {
                    check()?;
                    transitions.push((character, true));
                    if character == 'a' {
                        tx.send(()).unwrap();
                    }
                    wait(Duration::from_secs(2));
                    transitions.push((character, false)); // release even on cancel
                    note_character();
                    if let Err(error) = check() {
                        return Ok::<_, InputInterrupted>((transitions, error));
                    }
                }
                unreachable!()
            })
        });
        rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let at = Instant::now();
        signal.cancel();
        let (events, error) = worker.join().unwrap().unwrap();
        assert!(at.elapsed() < Duration::from_millis(250));
        assert_eq!(events, vec![('a', true), ('a', false)]);
        assert_eq!(error.posted_chars, 1);
        assert!(
            !InputCancellation::default().is_cancelled(),
            "another request remains live"
        );
    }
    #[test]
    fn dropped_future_and_session_end_revoke_only_the_owned_input() {
        let signal = InputCancellation::default();
        drop(signal.cancel_on_drop());
        assert!(signal.check().is_err());
        let session = "eido-input-cancellation-test";
        let owned = InputCancellation {
            session: Some(session.into()),
            ..Default::default()
        };
        crate::session::fire_session_end(session);
        assert!(owned.check().is_err());
        assert!(InputCancellation::default().check().is_ok());
    }
}
