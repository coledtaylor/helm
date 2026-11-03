//! What the host and its keeper say to each other: one frame at a time, each
//! a four-byte little-endian length and then that many bytes of CBOR.
//!
//! The first frame a keeper sends is always [`FromKeeper::Hello`], with its
//! version, and a host reads nothing else from a keeper of another version.
//! Serde names each variant, so a later version that adds variants still
//! reads and writes that greeting the same way.
//!
//! Nothing here carries a key, a code or a credential. A program is started
//! with its arguments, its folder and only the variables its backend adds for
//! that launch; the rest of its environment is the keeper's own, which the
//! host gave it when it started the keeper. An agent tool's token is in a
//! file in the launch's own folder, which an argument may name but never
//! holds.

use std::ffi::OsString;
use std::io;
use std::path::PathBuf;

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};
use serde_bytes::ByteBuf;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::session::{SessionExit, TermSize};

/// The largest frame either side reads: far more than a screen's redraw or
/// a pty's read, and far less than would hurt to hold.
const MOST_FRAME: usize = 64 << 20;

/// Which of the host's two kinds of terminal a program the keeper holds is.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum HeldKind {
    /// A session, with a row in the store.
    Session,
    /// A plain terminal, numbered by the host and recorded nowhere.
    Terminal,
}

/// What the host tells the keeper about a program it started, so that a
/// host starting after a crash knows what each one is.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Label {
    pub kind: HeldKind,
    /// The session's row, or the plain terminal's number.
    pub id: i64,
    /// The name it was started with: a plain terminal goes by its shell.
    pub name: String,
    /// The folder it runs in.
    pub cwd: PathBuf,
    /// The launch's own folder, which goes when the program ends.
    pub launch_folder: Option<PathBuf>,
    /// The fingerprint of the paired device that started it, whose
    /// deliberate quit ends it: a fingerprint names a device and proves
    /// nothing, so no key crosses here.
    #[serde(default)]
    pub opened_by: Option<String>,
}

/// How a program the keeper held ended.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WireExit {
    pub code: u32,
    pub signal: Option<String>,
}

impl From<&SessionExit> for WireExit {
    fn from(exit: &SessionExit) -> Self {
        Self {
            code: exit.code,
            signal: exit.signal.clone(),
        }
    }
}

impl From<WireExit> for SessionExit {
    fn from(exit: WireExit) -> Self {
        Self {
            code: exit.code,
            signal: exit.signal,
        }
    }
}

/// A program the keeper has started.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Spawned {
    pub handle: u64,
    pub pid: u32,
}

/// From the host to its keeper.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum ToKeeper {
    /// Start `program` in a new pty; answered with [`FromKeeper::Started`]
    /// naming `request`.
    Start {
        request: u64,
        program: OsString,
        args: Vec<OsString>,
        cwd: PathBuf,
        /// Only what the launch's backend adds to the keeper's own
        /// environment.
        env: Vec<(OsString, OsString)>,
        cols: u16,
        rows: u16,
    },
    /// What `handle` is, kept for the next host.
    Label { handle: u64, label: Label },
    /// Keys typed into `handle`.
    Input { handle: u64, bytes: ByteBuf },
    /// `handle`'s terminal is now this size.
    Resize { handle: u64, cols: u16, rows: u16 },
    /// Ask `handle`'s program to end, as closing its tab does, and end its
    /// tree outright once the grace has passed.
    Close { handle: u64 },
    /// End `handle`'s whole tree now.
    EndNow { handle: u64 },
    /// The host has recorded `handle`'s end: the keeper keeps nothing more
    /// of it.
    Forget { handle: u64 },
    /// End every tree, answer [`FromKeeper::Bye`] and exit: a deliberate
    /// stop.
    Shutdown,
}

/// From the keeper to its host.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum FromKeeper {
    /// The first frame on every connection.
    Hello { version: String, pid: u32 },
    /// One program the keeper holds, sent to a host as it connects: running,
    /// with its screen drawn again and its output from here on, or ended
    /// while no host was there, with how.
    Held {
        handle: u64,
        label: Option<Label>,
        pid: u32,
        cols: u16,
        rows: u16,
        redraw: ByteBuf,
        exit: Option<WireExit>,
    },
    /// Everything it holds has been sent.
    Ready,
    /// The answer to [`ToKeeper::Start`].
    Started {
        request: u64,
        outcome: Result<Spawned, String>,
    },
    /// Bytes `handle`'s program wrote, exactly as its pty gave them.
    Data { handle: u64, bytes: ByteBuf },
    /// `handle`'s program has ended. Nothing more comes for it.
    Exited { handle: u64, exit: WireExit },
    /// Every tree has ended and the keeper is exiting.
    Bye,
}

impl FromKeeper {
    /// A running program as a host connecting is told of it.
    pub fn held(
        handle: u64,
        label: Option<Label>,
        pid: u32,
        size: TermSize,
        redraw: Vec<u8>,
    ) -> Self {
        Self::Held {
            handle,
            label,
            pid,
            cols: size.cols,
            rows: size.rows,
            redraw: ByteBuf::from(redraw),
            exit: None,
        }
    }
}

/// Writes `frame` and flushes it.
pub(crate) async fn write_frame<W, T>(writer: &mut W, frame: &T) -> io::Result<()>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let mut body = Vec::new();
    ciborium::into_writer(frame, &mut body).map_err(io::Error::other)?;
    let length = u32::try_from(body.len())
        .ok()
        .filter(|length| *length as usize <= MOST_FRAME)
        .ok_or_else(|| io::Error::other("a frame too large to send"))?;
    writer.write_all(&length.to_le_bytes()).await?;
    writer.write_all(&body).await?;
    writer.flush().await
}

/// The next frame, or `None` once the other side has closed the connection
/// between frames.
pub(crate) async fn read_frame<R, T>(reader: &mut R) -> io::Result<Option<T>>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut length = [0u8; 4];
    match reader.read_exact(&mut length).await {
        Ok(_) => {}
        Err(err) if err.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(err) => return Err(err),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length > MOST_FRAME {
        return Err(io::Error::other(format!("a frame of {length} bytes")));
    }
    let mut body = vec![0u8; length];
    reader.read_exact(&mut body).await?;
    ciborium::from_reader(body.as_slice())
        .map(Some)
        .map_err(io::Error::other)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn every_frame_reads_back_as_it_was_written_and_a_close_between_frames_is_the_end() {
        let frames = vec![
            FromKeeper::Hello {
                version: "1.2.3".to_owned(),
                pid: 42,
            },
            FromKeeper::held(
                7,
                Some(Label {
                    kind: HeldKind::Terminal,
                    id: 3,
                    name: "a shell".to_owned(),
                    cwd: PathBuf::from("a folder with spaces"),
                    launch_folder: None,
                    opened_by: Some("SHA256:a device".to_owned()),
                }),
                9,
                TermSize::new(80, 24),
                b"\x1b[2Jdrawn".to_vec(),
            ),
            FromKeeper::Data {
                handle: 7,
                bytes: ByteBuf::from(vec![0, 255, 27]),
            },
            FromKeeper::Started {
                request: 1,
                outcome: Err("no such program".to_owned()),
            },
        ];
        let mut bytes = Vec::new();
        for frame in &frames {
            write_frame(&mut bytes, frame).await.unwrap();
        }
        let mut reader = bytes.as_slice();
        let mut read = Vec::new();
        while let Some(frame) = read_frame::<_, FromKeeper>(&mut reader).await.unwrap() {
            read.push(frame);
        }
        assert_eq!(read, frames);
    }

    #[tokio::test]
    async fn a_frame_longer_than_the_limit_is_refused_before_it_is_read() {
        let mut bytes = Vec::new();
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        let mut reader = bytes.as_slice();
        assert!(read_frame::<_, ToKeeper>(&mut reader).await.is_err());
    }
}
