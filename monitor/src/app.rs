//! Application state: the latest snapshot plus client-side time-series history
//! (per-hive and global) used to draw the activity sparklines. Rates are
//! derived from deltas of the hub's cumulative counters between ticks.

use std::collections::{HashMap, VecDeque};
use std::time::Instant;

use crate::client::{Client, Group, StatusReply};

pub const HIST_LEN: usize = 60;

#[derive(Default)]
pub struct GroupHist {
    pub msg: VecDeque<u64>,
    pub edit: VecDeque<u64>,
    prev_msg: u64,
    prev_edit: u64,
    seeded: bool,
}

impl GroupHist {
    fn push(&mut self, cur_msg: u64, cur_edit: u64) {
        let (dm, de) = if self.seeded {
            (cur_msg.saturating_sub(self.prev_msg), cur_edit.saturating_sub(self.prev_edit))
        } else {
            (0, 0)
        };
        self.prev_msg = cur_msg;
        self.prev_edit = cur_edit;
        self.seeded = true;
        push_ring(&mut self.msg, dm);
        push_ring(&mut self.edit, de);
    }
}

fn push_ring(ring: &mut VecDeque<u64>, v: u64) {
    ring.push_back(v);
    while ring.len() > HIST_LEN {
        ring.pop_front();
    }
}

pub struct App {
    pub client: Client,
    pub connected: bool,
    pub hub_now: i64,
    pub hub_started: i64,
    pub hub_pid: i64,
    pub hub_protocol: i64,
    pub groups: Vec<Group>,
    pub hist: HashMap<String, GroupHist>,
    pub global_msg: VecDeque<u64>,
    pub global_edit: VecDeque<u64>,
    pub selected: usize,
    pub paused: bool,
    pub input_mode: bool,
    pub input: String,
    pub status_line: String,
    pub last_fetch: Instant,
}

impl App {
    pub fn new() -> Self {
        App {
            client: Client::new(),
            connected: false,
            hub_now: 0,
            hub_started: 0,
            hub_pid: 0,
            hub_protocol: 0,
            groups: Vec::new(),
            hist: HashMap::new(),
            global_msg: VecDeque::new(),
            global_edit: VecDeque::new(),
            selected: 0,
            paused: false,
            input_mode: false,
            input: String::new(),
            status_line: String::from("starting…"),
            last_fetch: Instant::now()
                .checked_sub(std::time::Duration::from_secs(5))
                .unwrap_or_else(Instant::now),
        }
    }

    /// Poll the hub and fold the result into history. Called ~1/s.
    pub fn tick(&mut self) {
        self.last_fetch = Instant::now();
        match self.client.fetch_status() {
            Ok(reply) => {
                self.connected = true;
                self.status_line = String::from("connected");
                self.apply(reply);
            }
            Err(e) => {
                self.connected = false;
                self.status_line = format!("hub offline: {} (retrying)", e);
            }
        }
    }

    fn apply(&mut self, reply: StatusReply) {
        self.hub_now = reply.hub.now;
        self.hub_started = reply.hub.started_at;
        self.hub_pid = reply.hub.pid;
        self.hub_protocol = reply.hub.protocol;

        let mut total_msg = 0u64;
        let mut total_edit = 0u64;
        let mut live_ids = std::collections::HashSet::new();

        for g in &reply.groups {
            let cur_msg = g.stats.messages + g.stats.broadcasts;
            let cur_edit = g.stats.edits;
            let h = self.hist.entry(g.group.id.clone()).or_default();
            let prev_seeded = h.seeded;
            let (pm, pe) = (h.prev_msg(), h.prev_edit());
            h.push(cur_msg, cur_edit);
            if prev_seeded {
                total_msg += cur_msg.saturating_sub(pm);
                total_edit += cur_edit.saturating_sub(pe);
            }
            live_ids.insert(g.group.id.clone());
        }

        // Forget history for hives that have disappeared.
        self.hist.retain(|k, _| live_ids.contains(k));

        push_ring(&mut self.global_msg, total_msg);
        push_ring(&mut self.global_edit, total_edit);

        self.groups = reply.groups;
        if self.selected >= self.groups.len() {
            self.selected = self.groups.len().saturating_sub(1);
        }
    }

    pub fn select_next(&mut self) {
        if !self.groups.is_empty() {
            self.selected = (self.selected + 1) % self.groups.len();
        }
    }

    pub fn select_prev(&mut self) {
        if !self.groups.is_empty() {
            self.selected = (self.selected + self.groups.len() - 1) % self.groups.len();
        }
    }

    pub fn selected_group(&self) -> Option<&Group> {
        self.groups.get(self.selected)
    }

    pub fn submit_broadcast(&mut self) {
        let body = self.input.trim().to_string();
        self.input.clear();
        self.input_mode = false;
        if body.is_empty() {
            return;
        }
        if let Some(g) = self.groups.get(self.selected) {
            let id = g.group.id.clone();
            let label = g.group.label.clone();
            match self.client.say(&id, &body) {
                Ok(()) => self.status_line = format!("sent to hive \"{}\"", label),
                Err(e) => self.status_line = format!("send failed: {}", e),
            }
        } else {
            self.status_line = String::from("no hive selected");
        }
    }
}

impl GroupHist {
    fn prev_msg(&self) -> u64 {
        self.prev_msg
    }
    fn prev_edit(&self) -> u64 {
        self.prev_edit
    }
}
