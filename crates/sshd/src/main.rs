//! SSH front end for g1t. Accepts `git@g1t.sh:owner/repo.git`, authenticates
//! the client's public key against the g1t Worker, and bridges git to
//! Artifacts over HTTPS.
//!
//! Connections arrive either as raw TCP or wrapped in a WebSocket, which is
//! how they reach a Cloudflare Container when tunnelled through a Worker.
//!
//! Not deployed. Before it ships, its git operations must be metered: the
//! bridge reaches the store directly, so `git_http` never counts them (see
//! docs/ARTIFACTS.md, "where the gap came from").

mod api;
mod git;

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use russh::keys::PrivateKey;
use russh::keys::ssh_key::{HashAlg, PublicKey};
use russh::server::{Auth, Config, Handler, Msg, Session};
use russh::{Channel, ChannelId, MethodKind, MethodSet};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::net::TcpListener;
use tokio_tungstenite::tungstenite::Message;

use api::{Api, Service, User};

const TCP_ADDR: &str = "0.0.0.0:2222";
const WEBSOCKET_ADDR: &str = "0.0.0.0:8080";

#[tokio::main]
async fn main() -> Result<()> {
    let host_key = std::env::var("SSH_HOST_KEY").context("SSH_HOST_KEY is not set")?;
    let api = Arc::new(Api::new(
        std::env::var("G1T_API").unwrap_or_else(|_| "https://g1t.sh".into()),
        std::env::var("INTERNAL_SECRET").context("INTERNAL_SECRET is not set")?,
    ));
    let config = Arc::new(Config {
        keys: vec![PrivateKey::from_openssh(host_key).context("invalid SSH_HOST_KEY")?],
        methods: MethodSet::from(&[MethodKind::PublicKey][..]),
        auth_rejection_time: Duration::from_secs(1),
        auth_rejection_time_initial: Some(Duration::ZERO),
        inactivity_timeout: Some(Duration::from_secs(300)),
        ..Default::default()
    });

    let tcp = TcpListener::bind(TCP_ADDR).await?;
    let websocket = TcpListener::bind(WEBSOCKET_ADDR).await?;
    eprintln!("g1t-sshd listening on {TCP_ADDR} (tcp) and {WEBSOCKET_ADDR} (websocket)");
    loop {
        tokio::select! {
            accepted = tcp.accept() => {
                let (stream, _) = accepted?;
                tokio::spawn(run_session(config.clone(), api.clone(), stream));
            }
            accepted = websocket.accept() => {
                let (stream, _) = accepted?;
                let (config, api) = (config.clone(), api.clone());
                tokio::spawn(async move {
                    match tokio_tungstenite::accept_async(stream).await {
                        Ok(socket) => run_session(config, api, websocket_stream(socket)).await,
                        Err(error) => eprintln!("websocket handshake failed: {error}"),
                    }
                });
            }
        }
    }
}

async fn run_session<S>(config: Arc<Config>, api: Arc<Api>, stream: S)
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let handler = Connection {
        api,
        user: None,
        git_protocol: None,
        channels: HashMap::new(),
    };
    let result = match russh::server::run_stream(config, stream, handler).await {
        Ok(session) => session.await,
        Err(error) => Err(error),
    };
    if let Err(error) = result {
        eprintln!("session ended: {error:#}");
    }
}

/// Presents a WebSocket's binary messages as a plain byte stream.
fn websocket_stream<S>(socket: tokio_tungstenite::WebSocketStream<S>) -> tokio::io::DuplexStream
where
    S: AsyncRead + AsyncWrite + Unpin + Send + 'static,
{
    let (ours, theirs) = tokio::io::duplex(64 * 1024);
    let (mut sink, mut source) = socket.split();
    let (mut from_ssh, mut to_ssh) = tokio::io::split(theirs);
    tokio::spawn(async move {
        while let Some(Ok(message)) = source.next().await {
            if let Message::Binary(bytes) = message
                && to_ssh.write_all(&bytes).await.is_err() {
                    break;
                }
        }
        let _ = to_ssh.shutdown().await;
    });
    tokio::spawn(async move {
        let mut buffer = vec![0u8; 32 * 1024];
        loop {
            match from_ssh.read(&mut buffer).await {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    let message = Message::Binary(buffer[..read].to_vec().into());
                    if sink.send(message).await.is_err() {
                        break;
                    }
                }
            }
        }
        let _ = sink.close().await;
    });
    ours
}

struct Connection {
    api: Arc<Api>,
    user: Option<User>,
    /// Value of the `GIT_PROTOCOL` environment variable, if the client sent it.
    git_protocol: Option<String>,
    channels: HashMap<ChannelId, Channel<Msg>>,
}

impl Connection {
    async fn lookup(&self, key: &PublicKey) -> Result<Option<User>> {
        let fingerprint = key.fingerprint(HashAlg::Sha256).to_string();
        self.api.user_for_key(&fingerprint).await
    }
}

impl Handler for Connection {
    type Error = anyhow::Error;

    async fn auth_publickey_offered(&mut self, _: &str, key: &PublicKey) -> Result<Auth> {
        Ok(match self.lookup(key).await? {
            Some(_) => Auth::Accept,
            None => Auth::reject(),
        })
    }

    /// Called once the client has proven it holds the private key.
    async fn auth_publickey(&mut self, _: &str, key: &PublicKey) -> Result<Auth> {
        self.user = self.lookup(key).await?;
        Ok(match self.user {
            Some(_) => Auth::Accept,
            None => Auth::reject(),
        })
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _: &mut Session,
    ) -> Result<()> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn env_request(
        &mut self,
        channel: ChannelId,
        name: &str,
        value: &str,
        session: &mut Session,
    ) -> Result<()> {
        if name == "GIT_PROTOCOL" {
            self.git_protocol = Some(value.to_owned());
        }
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(&mut self, id: ChannelId, session: &mut Session) -> Result<()> {
        let (Some(user), Some(channel)) = (&self.user, self.channels.remove(&id)) else {
            return Ok(session.channel_failure(id)?);
        };
        session.channel_success(id)?;
        let greeting = format!(
            "Hi {}! You've successfully authenticated, but g1t does not provide shell access.\r\n",
            user.username
        );
        tokio::spawn(async move {
            let _ = channel.data(greeting.as_bytes()).await;
            finish(channel, 1).await;
        });
        Ok(())
    }

    async fn exec_request(
        &mut self,
        id: ChannelId,
        command: &[u8],
        session: &mut Session,
    ) -> Result<()> {
        let (Some(user), Some(channel)) = (self.user.clone(), self.channels.remove(&id)) else {
            return Ok(session.channel_failure(id)?);
        };
        session.channel_success(id)?;

        let command = String::from_utf8_lossy(command).into_owned();
        let protocol_v2 = self
            .git_protocol
            .as_deref()
            .is_some_and(|value| value.split(':').any(|part| part == "version=2"));
        let api = self.api.clone();
        tokio::spawn(async move {
            let (mut read_half, write_half) = channel.split();
            let mut reader = BufReader::new(read_half.make_reader());
            let mut writer = write_half.make_writer();
            let result =
                run_git(&api, &user, &command, protocol_v2, &mut reader, &mut writer).await;
            let status = match result {
                Ok(()) => 0,
                Err(error) => {
                    eprintln!("{}: `{command}` failed: {error:#}", user.username);
                    let _ = writer.write_all(&git::error_pkt("internal error")).await;
                    1
                }
            };
            let _ = writer.shutdown().await;
            let _ = write_half.exit_status(status).await;
            let _ = write_half.eof().await;
            let _ = write_half.close().await;
        });
        Ok(())
    }
}

async fn finish(channel: Channel<Msg>, status: u32) {
    let _ = channel.exit_status(status).await;
    let _ = channel.eof().await;
    let _ = channel.close().await;
}

/// Parses `git-upload-pack 'owner/repo.git'` and friends.
fn parse_command(command: &str) -> Option<(Service, &str, &str)> {
    let (program, path) = command.trim().rsplit_once(' ')?;
    let service = match program {
        "git-upload-pack" | "git upload-pack" => Service::UploadPack,
        "git-receive-pack" | "git receive-pack" => Service::ReceivePack,
        _ => return None,
    };
    let path = path.trim_matches(['\'', '"']).trim_start_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    (!owner.is_empty() && !repo.is_empty() && !repo.contains('/')).then_some((service, owner, repo))
}

async fn run_git<R, W>(
    api: &Api,
    user: &User,
    command: &str,
    protocol_v2: bool,
    reader: &mut R,
    writer: &mut W,
) -> Result<()>
where
    R: tokio::io::AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let Some((service, owner, repo)) = parse_command(command) else {
        writer
            .write_all(&git::error_pkt("g1t only supports git over SSH"))
            .await?;
        return Ok(());
    };
    match api.access(user, owner, repo, service).await? {
        Ok(access) => git::serve(&api.http, &access, service, protocol_v2, reader, writer).await,
        Err(message) => Ok(writer.write_all(&git::error_pkt(&message)).await?),
    }
}
