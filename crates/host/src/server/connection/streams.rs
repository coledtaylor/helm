//! What a connection's streams carry, and the tasks that feed them.
//!
//! A terminal stream carries a session's screen, then its output. The
//! session never waits for a client: its output reaches each attached client
//! as it comes, and what a client has no credit for is held for it. A client
//! that falls behind (what is held for one terminal passes
//! [`BEHIND_LIMIT`]) has it dropped, and once it grants credit again it is
//! attached afresh and sent a terminal reset ([`RESET`]) and the session's
//! current screen, and streams on from there. Every other client's stream
//! is its own, and gets every byte.
//!
//! A socket stream carries one connection on the host's loopback: what the
//! client sends is written to it, and the client is granted credit back once
//! it has been; what it answers is read only while the client has credit for
//! it, so neither side is held for more than a stream's credit.
//!
//! Every task sends what it has on the connection's one feed, tagged with
//! the stream and the token of the stream it was started for: a stream
//! reopened, or reattached after falling behind, has a new token, and what
//! the old tasks sent is dropped.

use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

use floti_protocol::DEFAULT_INITIAL_CREDIT;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::sync::Semaphore;
use tokio::sync::mpsc::{UnboundedReceiver, UnboundedSender};
use tokio::task::JoinHandle;

use super::super::features::StreamAttachment;
use crate::session::{Session, SessionOutput};

/// How much one terminal stream may hold for a client that is not taking
/// it before it is dropped: four times the credit a stream starts with.
pub(super) const BEHIND_LIMIT: usize = 4 * DEFAULT_INITIAL_CREDIT as usize;

/// What a client that fell behind is sent before the current screen: a full
/// terminal reset (`ESC c`), so nothing of the screen it last drew is kept.
pub(super) const RESET: &[u8] = b"\x1bc";

/// The most a socket stream reads at once.
const SOCKET_CHUNK: usize = 64 * 1024;

/// What one open stream carries.
pub(super) enum Carried {
    /// A session's or plain terminal's screen and output.
    Terminal {
        session: Arc<Session>,
        forward: JoinHandle<()>,
        /// The output held for the client was dropped: once it grants
        /// credit again it is sent the current screen.
        behind: bool,
    },
    /// Waiting on the work that opens it. What the client sends meanwhile
    /// is kept, under its credit, for once it is open.
    Opening { work: JoinHandle<()>, sent: Vec<u8> },
    /// A connection on the host's loopback.
    Socket {
        to_socket: UnboundedSender<Vec<u8>>,
        /// Bytes the client has credit for that have not been read yet.
        room: Arc<Semaphore>,
        reader: JoinHandle<()>,
        writer: JoinHandle<()>,
    },
}

impl Carried {
    /// Stops every task it runs. A socket's halves go with its tasks, which
    /// closes the connection.
    pub fn stop(&self) {
        match self {
            Self::Terminal { forward, .. } => forward.abort(),
            Self::Opening { work, .. } => work.abort(),
            Self::Socket { reader, writer, .. } => {
                reader.abort();
                writer.abort();
            }
        }
    }

    /// The session it is a terminal of.
    pub fn session(&self) -> Option<&Arc<Session>> {
        match self {
            Self::Terminal { session, .. } => Some(session),
            _ => None,
        }
    }
}

/// One thing a stream's task has for the connection.
pub(super) struct Feed {
    pub stream: u64,
    /// The token of the stream the task was started for.
    pub token: u64,
    pub fed: Fed,
}

pub(super) enum Fed {
    /// A terminal's output.
    Output(SessionOutput),
    /// The work opening the stream is done.
    Opened(Result<StreamAttachment, String>),
    /// Bytes the socket answered.
    Received(Vec<u8>),
    /// This many of the client's bytes were written to the socket.
    Written(u64),
    /// The socket is done: the server closed it (no sentence), or it failed
    /// or its session ended (the sentence the stream is closed with).
    Ended(Option<String>),
}

/// Sends `fed` for `stream`'s `token`; a connection that has gone hears
/// nothing.
fn send(feed: &UnboundedSender<Feed>, stream: u64, token: u64, fed: Fed) -> bool {
    feed.send(Feed { stream, token, fed }).is_ok()
}

/// Carries a terminal's output onto the feed.
pub(super) fn forward_output(
    stream: u64,
    token: u64,
    mut output: UnboundedReceiver<SessionOutput>,
    feed: UnboundedSender<Feed>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(item) = output.recv().await {
            if !send(&feed, stream, token, Fed::Output(item)) {
                return;
            }
        }
    })
}

/// Reads what the socket answers while the client has credit for it
/// (`room`), until it closes, fails or `ended` settles.
pub(super) fn read_socket(
    mut read: OwnedReadHalf,
    room: Arc<Semaphore>,
    mut ended: Pin<Box<dyn Future<Output = String> + Send>>,
    stream: u64,
    token: u64,
    feed: UnboundedSender<Feed>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        let mut buf = vec![0; SOCKET_CHUNK];
        loop {
            let permit = tokio::select! {
                why = &mut ended => {
                    send(&feed, stream, token, Fed::Ended(Some(why)));
                    return;
                }
                permit = room.acquire() => permit,
            };
            let Ok(permit) = permit else {
                return;
            };
            permit.forget();
            let mut allowed = 1;
            let extra = room.available_permits().min(SOCKET_CHUNK - 1);
            if let Ok(more) = room.try_acquire_many(u32::try_from(extra).unwrap_or(0)) {
                more.forget();
                allowed += extra;
            }
            let read = tokio::select! {
                why = &mut ended => {
                    send(&feed, stream, token, Fed::Ended(Some(why)));
                    return;
                }
                read = read.read(&mut buf[..allowed]) => read,
            };
            match read {
                Ok(0) => {
                    send(&feed, stream, token, Fed::Ended(None));
                    return;
                }
                Ok(n) => {
                    room.add_permits(allowed - n);
                    if !send(&feed, stream, token, Fed::Received(buf[..n].to_vec())) {
                        return;
                    }
                }
                Err(err) => {
                    send(
                        &feed,
                        stream,
                        token,
                        Fed::Ended(Some(format!("The forwarded connection failed: {err}."))),
                    );
                    return;
                }
            }
        }
    })
}

/// Writes what the client sends to the socket, saying how much each time,
/// until the client closes the stream.
pub(super) fn write_socket(
    mut write: OwnedWriteHalf,
    mut from_client: UnboundedReceiver<Vec<u8>>,
    stream: u64,
    token: u64,
    feed: UnboundedSender<Feed>,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        while let Some(bytes) = from_client.recv().await {
            if let Err(err) = write.write_all(&bytes).await {
                send(
                    &feed,
                    stream,
                    token,
                    Fed::Ended(Some(format!("The forwarded connection failed: {err}."))),
                );
                return;
            }
            if !send(&feed, stream, token, Fed::Written(bytes.len() as u64)) {
                return;
            }
        }
        let _ = write.shutdown().await;
    })
}
