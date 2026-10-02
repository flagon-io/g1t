//! Bridges git's stateful SSH transport to the stateless smart HTTP protocol
//! spoken by Artifacts.

use anyhow::{Result, bail, ensure};
use flate2::{Decompress, FlushDecompress, Status};
use futures_util::StreamExt;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::api::{Access, Service};

const FLUSH: &[u8] = b"0000";
const ZERO_ID: &str = "0000000000000000000000000000000000000000";

/// A pkt-line carrying `ERR`, which git prints as `fatal: remote error: …`.
pub fn error_pkt(message: &str) -> Vec<u8> {
    let payload = format!("ERR {message}\n");
    format!("{:04x}{payload}", payload.len() + 4).into_bytes()
}

pub async fn serve<R, W>(
    http: &reqwest::Client,
    access: &Access,
    service: Service,
    protocol_v2: bool,
    reader: &mut R,
    writer: &mut W,
) -> Result<()>
where
    R: AsyncBufRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let bridge = Bridge {
        http,
        access,
        service,
        // Artifacts only supports version 2 for fetches.
        protocol_v2: protocol_v2 && service == Service::UploadPack,
    };
    match service {
        Service::UploadPack => bridge.upload_pack(reader, writer).await,
        Service::ReceivePack => bridge.receive_pack(reader, writer).await,
    }
}

struct Bridge<'a> {
    http: &'a reqwest::Client,
    access: &'a Access,
    service: Service,
    protocol_v2: bool,
}

impl Bridge<'_> {
    fn request(&self, method: reqwest::Method, path: &str) -> reqwest::RequestBuilder {
        let mut request = self
            .http
            .request(method, format!("{}/{path}", self.access.remote))
            .bearer_auth(&self.access.token);
        if self.protocol_v2 {
            request = request.header("git-protocol", "version=2");
        }
        request
    }

    /// Sends the ref advertisement, which over SSH comes without the
    /// `# service=…` section that smart HTTP prepends.
    async fn advertise<W: AsyncWrite + Unpin>(&self, writer: &mut W) -> Result<()> {
        let service = self.service.as_str();
        let response = self
            .request(
                reqwest::Method::GET,
                &format!("info/refs?service={service}"),
            )
            .send()
            .await?
            .error_for_status()?;
        let body = response.bytes().await?;
        let mut advertisement = &body[..];
        if advertisement
            .get(4..)
            .is_some_and(|rest| rest.starts_with(b"# service="))
        {
            let length = usize::from_str_radix(std::str::from_utf8(&body[..4])?, 16)?;
            ensure!(body.len() >= length + 4, "truncated ref advertisement");
            advertisement = &body[length + 4..];
        }
        writer.write_all(advertisement).await?;
        writer.flush().await?;
        Ok(())
    }

    /// Posts one request and streams the response back to the client.
    async fn rpc<W: AsyncWrite + Unpin>(&self, body: Vec<u8>, writer: &mut W) -> Result<()> {
        let service = self.service.as_str();
        let response = self
            .request(reqwest::Method::POST, service)
            .header("content-type", format!("application/x-{service}-request"))
            .header("accept", format!("application/x-{service}-result"))
            .body(body)
            .send()
            .await?
            .error_for_status()?;
        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            writer.write_all(&chunk?).await?;
        }
        writer.flush().await?;
        Ok(())
    }

    /// Protocol v2 is a series of self-contained commands, so each one maps
    /// onto a single HTTP request.
    async fn upload_pack<R, W>(&self, reader: &mut R, writer: &mut W) -> Result<()>
    where
        R: AsyncBufRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        if !self.protocol_v2 {
            writer
                .write_all(&error_pkt(
                    "g1t needs git protocol version 2 over SSH (git 2.26 or newer)",
                ))
                .await?;
            return Ok(());
        }
        self.advertise(writer).await?;
        loop {
            let mut command = Vec::new();
            if reader.fill_buf().await?.is_empty() {
                return Ok(());
            }
            read_section(reader, &mut command).await?;
            if command == FLUSH {
                return Ok(());
            }
            self.rpc(command, writer).await?;
        }
    }

    async fn receive_pack<R, W>(&self, reader: &mut R, writer: &mut W) -> Result<()>
    where
        R: AsyncBufRead + Unpin,
        W: AsyncWrite + Unpin,
    {
        self.advertise(writer).await?;
        if reader.fill_buf().await?.is_empty() {
            return Ok(());
        }
        let mut body = Vec::new();
        let lines = read_section(reader, &mut body).await?;
        let commands: Vec<&str> = lines
            .iter()
            .filter(|line| !line.starts_with("shallow "))
            .map(String::as_str)
            .collect();
        // A bare flush means the client had nothing to push.
        let Some(first) = commands.first() else {
            return Ok(());
        };
        let capabilities = first.split_once('\0').map_or("", |(_, caps)| caps);
        let has_push_options = capabilities.split(' ').any(|cap| cap == "push-options");
        // Commands are "<old id> <new id> <ref>"; only deletions send no pack.
        let sends_pack = commands
            .iter()
            .any(|command| command.split(' ').nth(1) != Some(ZERO_ID));

        if has_push_options {
            read_section(reader, &mut body).await?;
        }
        if sends_pack {
            read_pack(reader, &mut body).await?;
        }
        self.rpc(body, writer).await
    }
}

/// Reads pkt-lines up to and including the next flush, appending the raw
/// bytes to `raw`. Returns the payload of each line.
async fn read_section<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    raw: &mut Vec<u8>,
) -> Result<Vec<String>> {
    let mut lines = Vec::new();
    loop {
        let mut header = [0u8; 4];
        reader.read_exact(&mut header).await?;
        raw.extend_from_slice(&header);
        let length = usize::from_str_radix(std::str::from_utf8(&header)?, 16)?;
        match length {
            0 => return Ok(lines),
            // Delimiter and response-end packets carry no payload.
            1 | 2 => continue,
            3 => bail!("invalid pkt-line length"),
            _ => {
                let mut payload = vec![0u8; length - 4];
                reader.read_exact(&mut payload).await?;
                raw.extend_from_slice(&payload);
                lines.push(String::from_utf8_lossy(&payload).trim_end().to_owned());
            }
        }
    }
}

async fn read_into<R: AsyncBufRead + Unpin>(
    reader: &mut R,
    raw: &mut Vec<u8>,
    count: usize,
) -> Result<()> {
    let start = raw.len();
    raw.resize(start + count, 0);
    reader.read_exact(&mut raw[start..]).await?;
    Ok(())
}

async fn read_byte<R: AsyncBufRead + Unpin>(reader: &mut R, raw: &mut Vec<u8>) -> Result<u8> {
    let byte = reader.read_u8().await?;
    raw.push(byte);
    Ok(byte)
}

/// Reads exactly one packfile. Over SSH nothing marks where the pack ends
/// (the client keeps the channel open for the reply), so the only way to
/// find the end is to walk every object.
async fn read_pack<R: AsyncBufRead + Unpin>(reader: &mut R, raw: &mut Vec<u8>) -> Result<()> {
    const OFS_DELTA: u8 = 6;
    const REF_DELTA: u8 = 7;

    let start = raw.len();
    read_into(reader, raw, 12).await?;
    ensure!(&raw[start..start + 4] == b"PACK", "expected a packfile");
    let objects = u32::from_be_bytes(raw[start + 8..start + 12].try_into()?);

    let mut scratch = vec![0u8; 64 * 1024];
    for _ in 0..objects {
        // Type and size header: a varint whose first byte holds the type.
        let mut byte = read_byte(reader, raw).await?;
        let kind = (byte >> 4) & 7;
        while byte & 0x80 != 0 {
            byte = read_byte(reader, raw).await?;
        }
        match kind {
            OFS_DELTA => while read_byte(reader, raw).await? & 0x80 != 0 {},
            REF_DELTA => read_into(reader, raw, 20).await?,
            _ => {}
        }

        let mut inflate = Decompress::new(true);
        loop {
            let input = reader.fill_buf().await?;
            ensure!(!input.is_empty(), "packfile ended mid-object");
            let before = inflate.total_in();
            let status = inflate.decompress(input, &mut scratch, FlushDecompress::None)?;
            let consumed = (inflate.total_in() - before) as usize;
            raw.extend_from_slice(&input[..consumed]);
            reader.consume(consumed);
            if status == Status::StreamEnd {
                break;
            }
        }
    }
    // Trailing SHA-1 checksum.
    read_into(reader, raw, 20).await
}
