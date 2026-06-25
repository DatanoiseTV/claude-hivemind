//! Hub client: connects to the same Unix socket the Node hub binds, speaks the
//! NDJSON control protocol, and deserializes the `status` snapshot. The path is
//! resolved identically to `src/lib/common.js` so the monitor and the hub agree
//! on where the socket lives.

use std::io::{self, BufRead, BufReader, ErrorKind, Write};
use std::os::unix::net::UnixStream;
use std::path::PathBuf;
use std::time::Duration;

use serde::Deserialize;

/// Mirror of common.js socketPath() for non-Windows platforms.
pub fn socket_path() -> PathBuf {
    let base = std::env::var("XDG_RUNTIME_DIR")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let uid = unsafe { libc::getuid() };
    base.join(format!("claude-hivemind-{}", uid)).join("hub.sock")
}

// --- Wire types (subset of the hub snapshot we render) ---------------------

#[derive(Debug, Clone, Deserialize, Default)]
pub struct StatusReply {
    #[serde(default)]
    pub hub: Hub,
    #[serde(default)]
    pub groups: Vec<Group>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Hub {
    #[serde(default)]
    pub now: i64,
    #[serde(default)]
    pub started_at: i64,
    #[serde(default)]
    pub pid: i64,
    #[serde(default)]
    pub protocol: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Group {
    #[serde(default)]
    pub group: GroupRef,
    #[serde(default)]
    pub agents: Vec<Agent>,
    #[serde(default)]
    pub tasks: Vec<Task>,
    #[serde(default)]
    pub notes: Vec<Note>,
    #[serde(default)]
    pub locks: Vec<Lock>,
    #[serde(default)]
    pub roles: Vec<Role>,
    #[serde(default)]
    pub participants: Vec<Participant>,
    #[serde(default)]
    pub activity: Vec<Activity>,
    #[serde(default)]
    pub changes: Vec<Change>,
    #[serde(default)]
    pub stats: Stats,
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct GroupRef {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub label: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Agent {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub client: String,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub capabilities: Vec<String>,
    #[serde(default)]
    pub current_task: Option<String>,
    #[serde(default)]
    pub dispatchable: bool,
    #[serde(default)]
    pub last_active_at: i64,
    #[serde(default)]
    pub last_seen: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Task {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub status: String,
    #[serde(default)]
    pub claimed_by: Option<String>,
    #[serde(default)]
    pub ready: bool,
    #[serde(default)]
    pub priority: i64,
    #[serde(default)]
    pub deps: Vec<String>,
    #[serde(default)]
    pub blocked_by: Vec<String>,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub mirrored: bool,
    #[serde(default)]
    pub owner: Option<String>,
}

// The following types mirror the full hub wire format. Some fields are not
// rendered by the current dashboard layout; they are retained so the protocol
// stays documented in one place and new panels can use them without re-deriving.
#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Note {
    #[serde(default)]
    pub key: String,
    #[serde(default)]
    pub summary: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Lock {
    #[serde(default)]
    pub resource: String,
    #[serde(default)]
    pub holder: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Role {
    #[serde(default)]
    pub role: String,
    #[serde(default)]
    pub holder: String,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Participant {
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub pending: u64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Activity {
    #[serde(default)]
    pub from_name: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub kind: String,
    #[serde(default)]
    pub ts: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
pub struct Change {
    #[serde(default)]
    pub who: String,
    #[serde(default)]
    pub file: String,
    #[serde(default)]
    pub tool: String,
    #[serde(default)]
    pub ts: i64,
}

#[allow(dead_code)]
#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    #[serde(default)]
    pub messages: u64,
    #[serde(default)]
    pub broadcasts: u64,
    #[serde(default)]
    pub edits: u64,
    #[serde(default)]
    pub turns: u64,
    #[serde(default)]
    pub tasks_posted: u64,
    #[serde(default)]
    pub peak_agents: u64,
}

// --- Connection -------------------------------------------------------------

pub struct Client {
    stream: Option<UnixStream>,
    reader: Option<BufReader<UnixStream>>,
}

impl Client {
    pub fn new() -> Self {
        Client { stream: None, reader: None }
    }

    fn connect(&mut self) -> io::Result<()> {
        let s = UnixStream::connect(socket_path())?;
        s.set_read_timeout(Some(Duration::from_millis(1500)))?;
        s.set_write_timeout(Some(Duration::from_millis(1000)))?;
        let r = BufReader::new(s.try_clone()?);
        self.stream = Some(s);
        self.reader = Some(r);
        Ok(())
    }

    fn disconnect(&mut self) {
        self.stream = None;
        self.reader = None;
    }

    fn ensure(&mut self) -> io::Result<()> {
        if self.stream.is_none() {
            self.connect()?;
        }
        Ok(())
    }

    /// Send one request line and read exactly one reply line. The protocol is
    /// strict request/reply with no unsolicited pushes, so this never desyncs.
    fn request(&mut self, line: &str) -> io::Result<String> {
        self.ensure()?;
        {
            let s = self.stream.as_mut().unwrap();
            s.write_all(line.as_bytes())?;
            s.write_all(b"\n")?;
            s.flush()?;
        }
        let r = self.reader.as_mut().unwrap();
        let mut buf = String::new();
        let n = r.read_line(&mut buf)?;
        if n == 0 {
            return Err(io::Error::new(ErrorKind::UnexpectedEof, "hub closed connection"));
        }
        Ok(buf)
    }

    pub fn fetch_status(&mut self) -> io::Result<StatusReply> {
        match self.request(r#"{"id":"1","op":"status"}"#) {
            Ok(resp) => serde_json::from_str(&resp)
                .map_err(|e| io::Error::new(ErrorKind::InvalidData, e)),
            Err(e) => {
                self.disconnect();
                Err(e)
            }
        }
    }

    /// Operator broadcast into a hive.
    pub fn say(&mut self, group: &str, body: &str) -> io::Result<()> {
        let v = serde_json::json!({
            "id": "2", "op": "say", "group": group, "from": "operator", "body": body
        });
        match self.request(&v.to_string()) {
            Ok(_) => Ok(()),
            Err(e) => {
                self.disconnect();
                Err(e)
            }
        }
    }
}
