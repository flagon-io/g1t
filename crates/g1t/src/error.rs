//! What a command can fail with, and the exit code each failure gives.
//!
//! The codes are stable, so scripts and agents can branch on them:
//!
//! | Code | Meaning |
//! | --- | --- |
//! | 0 | It worked. |
//! | 1 | It failed: the API refused, the network failed, checks failed. |
//! | 2 | The command was used wrongly: a flag, an argument, a JSON field. |
//! | 4 | Signing in is needed, or the token was refused. |
//! | 8 | Checks are still running (`g1t pr checks` without `--watch`). |

use std::fmt;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Failed,
    Usage,
    Auth,
    Pending,
}

impl Kind {
    pub fn code(self) -> u8 {
        match self {
            Kind::Failed => 1,
            Kind::Usage => 2,
            Kind::Auth => 4,
            Kind::Pending => 8,
        }
    }
}

#[derive(Debug)]
pub struct Error {
    pub kind: Kind,
    pub message: String,
    /// Already said on stderr: exit with the code and print nothing more.
    pub silent: bool,
}

pub type Result<T> = std::result::Result<T, Error>;

impl Error {
    pub fn failed(message: impl Into<String>) -> Error {
        Error {
            kind: Kind::Failed,
            message: message.into(),
            silent: false,
        }
    }
    pub fn usage(message: impl Into<String>) -> Error {
        Error {
            kind: Kind::Usage,
            message: message.into(),
            silent: false,
        }
    }
    pub fn auth(message: impl Into<String>) -> Error {
        Error {
            kind: Kind::Auth,
            message: message.into(),
            silent: false,
        }
    }
    /// Exit with `kind`'s code without another line: the output said why.
    pub fn exit(kind: Kind) -> Error {
        Error {
            kind,
            message: String::new(),
            silent: true,
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl From<String> for Error {
    fn from(message: String) -> Error {
        Error::failed(message)
    }
}

impl From<&str> for Error {
    fn from(message: &str) -> Error {
        Error::failed(message)
    }
}

impl From<std::io::Error> for Error {
    fn from(error: std::io::Error) -> Error {
        Error::failed(error.to_string())
    }
}
