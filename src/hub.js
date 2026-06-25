'use strict';

// The hive hub: a single per-user background daemon that every Claude Code
// instance connects to over a Unix socket. It holds all shared state in memory
// and routes between instances. State is partitioned by "group" (one project /
// git work-tree = one group), so instances in different projects never see
// each other.
//
// Responsibilities:
//   - Presence:   who is online in each group, liveness via socket + heartbeat.
//   - Messaging:  direct messages and group broadcasts, queued per recipient.
//   - Task board: a shared work queue with atomic claim (work-stealing).
//   - Context:    a shared key/value blackboard for findings and decisions.
//   - Locks:      advisory resource locks to avoid clobbering each other.
//   - Long-poll:  `wait` parks a request until something relevant happens.
//
// The daemon is disposable: it keeps nothing on disk, auto-starts on demand,
// and auto-exits when idle. Losing it loses only in-flight coordination state,
// never user work.

const net = require('net');
const fs = require('fs');
const path = require('path');
const C = require('./lib/common');
const { createProjectWatcher } = require('./lib/watcher');

// Filesystem watching is on by default; HIVEMIND_WATCH=off disables it globally.
const WATCH_ENABLED = (process.env.HIVEMIND_WATCH || '').toLowerCase() !== 'off';
const WATCH_IGNORE = (process.env.HIVEMIND_WATCH_IGNORE || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
const AGENT_EDIT_DEDUP_MS = 8000; // external change within this of an agent edit = the agent's own

// Limits are sized for large, long-running projects with many cooperating
// instances. They stay bounded so a runaway producer can't exhaust memory, but
// the ceilings are high enough that normal hive traffic never hits them.
const IDLE_SHUTDOWN_MS = 60 * 60 * 1000; // exit after 60 min with zero agents
const AGENT_STALE_MS = 120 * 1000; // reap agents silent for 120s (heartbeat is 15s)
const SWEEP_MS = 5 * 1000;
const EDIT_INTENT_WINDOW_MS = 180 * 1000; // concurrent-edit conflict window
const MAX_INBOX = 5000; // cap per-agent message queue
const MAX_BROADCASTS = 2000; // cap per-group ambient feed
const MAX_CHANGES = 5000; // cap per-group repo-change feed
const MAX_TASKS = 5000; // cap per-group task board (oldest done/failed pruned)
const DEFAULT_LOCK_TTL_MS = 15 * 60 * 1000;
const MAX_LOCK_TTL_MS = 4 * 60 * 60 * 1000;
const MAX_WAIT_MS = 5 * 60 * 1000; // longest a single long-poll may block
const MAX_BARRIER_MS = 60 * 60 * 1000; // longest a barrier may hold
const PERSIST_DEBOUNCE_MS = 1500; // coalesce durable-state writes
const ACTIVE_MAILBOX_MS = 5 * 60 * 1000; // a named participant counts as "present" if used within this
const MAILBOX_TTL_MS = 30 * 60 * 1000; // reap idle, empty named mailboxes
const MIRROR_TTL_MS = 2 * 60 * 60 * 1000; // drop mirrored tasks from long-silent sessions

function log(msg) {
  process.stderr.write(`[hub ${new Date().toISOString()}] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** @type {Map<string, Group>} */
const groups = new Map();
let lastAgentSeenAt = C.now();
const HUB_STARTED_AT = C.now();

function getGroup(id, label) {
  let g = groups.get(id);
  if (!g) {
    g = {
      id,
      label: label || id,
      agents: new Map(), // agentId -> agent
      inboxes: new Map(), // agentId -> message[]
      mailboxes: new Map(), // name -> { messages: [], lastSeen } — named, socket-less participants (e.g. subagents)
      tasks: [], // task[]
      notes: new Map(), // key -> { value, summary, by, byName, ts }
      locks: new Map(), // resource -> { by, byName, ts, ttlMs }
      broadcasts: [], // ambient feed for hook digests (capped)
      editIntents: new Map(), // file -> { sessionKey, who, ts }
      waiters: new Set(), // outstanding long-poll waiters
      barriers: new Map(), // name -> { parties, arrived: Map<agentId, waiter> }
      roles: new Map(), // role -> { by, byName, ts } (leader election)
      recentChanges: [], // { who, file, tool, ts } ring of repo mutations
      recentAgentEdits: new Map(), // absPath -> ts (to dedup FS events vs agent edits)
      sessionActivity: new Map(), // sessionKey -> { label, ts } (turn awareness)
      dir: '', // project directory (captured from the first registrant's cwd)
      watcher: null, // filesystem watcher handle
      taskSeq: 0,
      persistTimer: null,
      // Cumulative counters so the dashboard can derive live rates from deltas.
      stats: { messages: 0, broadcasts: 0, edits: 0, turns: 0, fsChanges: 0, tasksPosted: 0, peakAgents: 0, createdAt: C.now() },
    };
    groups.set(id, g);
    restoreGroup(g); // rehydrate durable task board + shared context, if any
  }
  if (label) g.label = label;
  return g;
}

// ---------------------------------------------------------------------------
// Durable state: the task board and shared-context blackboard survive a hub
// restart (crash, idle-exit, machine reboot). Everything else is ephemeral.
// ---------------------------------------------------------------------------

function schedulePersist(group) {
  if (group.persistTimer) return;
  group.persistTimer = setTimeout(() => {
    group.persistTimer = null;
    persistNow(group);
  }, PERSIST_DEBOUNCE_MS);
  if (group.persistTimer.unref) group.persistTimer.unref();
}

function persistNow(group) {
  const data = {
    v: 1,
    label: group.label,
    taskSeq: group.taskSeq,
    // Mirrored tasks reflect a live session's plan; never persist them.
    tasks: group.tasks.filter((t) => !t.mirrored),
    notes: [...group.notes.entries()],
    stats: group.stats,
    savedAt: C.now(),
  };
  // Async + atomic (tmp then rename) so a disk write never blocks the hub's
  // single-threaded event loop — message throughput is unaffected by persistence.
  const p = C.groupStatePath(group.id);
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 }, (err) => {
    if (err) {
      log(`persist write failed for ${group.id}: ${err.message}`);
      return;
    }
    fs.rename(tmp, p, (err2) => {
      if (err2) log(`persist rename failed for ${group.id}: ${err2.message}`);
    });
  });
}

function restoreGroup(group) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(C.groupStatePath(group.id), 'utf8'));
  } catch (_) {
    return; // nothing saved yet
  }
  if (!data || data.v !== 1) return;
  group.label = data.label || group.label;
  group.taskSeq = data.taskSeq || 0;
  group.tasks = Array.isArray(data.tasks) ? data.tasks : [];
  // In-flight work owned by agents that are now gone (the hub just restarted)
  // is reopened so a fresh fleet can pick it back up.
  for (const t of group.tasks) {
    if (t.status === 'claimed' || t.status === 'in_progress') {
      t.status = 'open';
      t.claimedBy = null;
      (t.log = t.log || []).push({ ts: C.now(), by: 'hive', note: 'reopened (hub restart)' });
    }
  }
  for (const [k, v] of data.notes || []) group.notes.set(k, v);
  if (data.stats) group.stats = { ...group.stats, ...data.stats, peakAgents: 0 };
  log(`restored ${group.tasks.length} task(s) and ${group.notes.size} note(s) for ${group.label} [${group.id}]`);
}

function totalAgents() {
  let n = 0;
  for (const g of groups.values()) n += g.agents.size;
  return n;
}

// ---------------------------------------------------------------------------
// Serialization helpers (strip internal fields before sending to clients)
// ---------------------------------------------------------------------------

function publicAgent(a) {
  return {
    id: a.id,
    name: a.name,
    cwd: a.cwd,
    pid: a.pid,
    client: a.client || '',
    model: a.model,
    status: a.status,
    capabilities: a.capabilities || [],
    currentTask: a.currentTask || null,
    dispatchable: !!a.inputChannel,
    joinedAt: a.joinedAt,
    lastSeen: a.lastSeen,
  };
}

// The acting party's display name for an op. An explicit `as` always wins (a
// subagent or script acting under its own sub-identity, even over the shared
// session connection); then a registered agent's name; else the connection id.
function actorName(msg, cs) {
  if (msg && msg.as) return String(msg.as).slice(0, 60);
  const a = currentAgent(cs);
  if (a) return a.name;
  return cs.agentId || 'anon';
}

// A task is "ready" when it is open and every dependency it names has reached a
// terminal-good state (done). This is what turns a flat list into a dependency
// graph: workers only ever claim ready work, so phases naturally serialize while
// independent work runs in parallel.
function unmetDeps(group, task) {
  if (!task.deps || !task.deps.length) return [];
  const byId = new Map(group.tasks.map((t) => [t.id, t]));
  return task.deps.filter((d) => {
    const dep = byId.get(d);
    return !dep || dep.status !== 'done';
  });
}

function taskReady(group, task) {
  // Mirrored tasks reflect another instance's own plan — they show on the board
  // for awareness but are never claimable work for others.
  if (task.mirrored) return false;
  return task.status === 'open' && unmetDeps(group, task).length === 0;
}

// Annotate tasks for the wire with derived fields the clients render.
function publicTasks(group) {
  return group.tasks.map((t) => ({
    ...t,
    ready: taskReady(group, t),
    blockedBy: t.status === 'open' ? unmetDeps(group, t) : [],
  }));
}

// Pick the best ready task for a claimer: prefer ones whose tags match the
// claimer's capabilities, then higher priority, then oldest. Returns null if no
// ready task exists.
function bestReadyTask(group, capabilities) {
  const caps = new Set(capabilities || []);
  const ready = group.tasks.filter((t) => taskReady(group, t));
  if (!ready.length) return null;
  const score = (t) => {
    const tags = t.tags || [];
    const match = tags.length && tags.some((tag) => caps.has(tag)) ? 1 : 0;
    return { match, priority: t.priority || 0, seq: Number(t.id.slice(1)) || 0 };
  };
  ready.sort((a, b) => {
    const sa = score(a);
    const sb = score(b);
    if (sb.match !== sa.match) return sb.match - sa.match;
    if (sb.priority !== sa.priority) return sb.priority - sa.priority;
    return sa.seq - sb.seq;
  });
  return ready[0];
}

// Shared by task_claim and task_next. Atomic (single-threaded hub): the open
// check-and-set cannot race, so exactly one claimer wins a task.
function claimTask(g, cs, taskId, asName) {
  const a = currentAgent(cs);
  const who = a ? a.name : asName || cs.agentId;
  const task = g.tasks.find((t) => t.id === taskId);
  if (!task) throw new Error(`no task ${taskId}`);
  if (task.status !== 'open') {
    throw new Error(`task ${task.id} is ${task.status} (owner ${task.claimedBy || '-'})`);
  }
  const unmet = unmetDeps(g, task);
  if (unmet.length) {
    throw new Error(`task ${task.id} is blocked by unfinished deps: ${unmet.join(', ')}`);
  }
  task.status = 'claimed';
  task.claimedBy = who;
  task.updatedAt = C.now();
  task.log.push({ ts: C.now(), by: who, note: 'claimed' });
  // Auto-presence: peers and the dashboard now see what this instance is on.
  if (a) {
    a.currentTask = task.id;
    a.status = `on ${task.id}: ${task.title.slice(0, 40)}`;
  }
  pushBroadcastFeed(g, who, `claimed task ${task.id}: ${task.title}`, 'task');
  schedulePersist(g);
  pumpWaiters(g);
  return { task: { ...task, ready: false } };
}

function peersOf(group, exceptId) {
  const out = [];
  for (const a of group.agents.values()) {
    if (a.id === exceptId) continue;
    out.push(publicAgent(a));
  }
  return out;
}

function publicNotes(group) {
  const out = [];
  for (const [key, n] of group.notes) {
    out.push({ key, summary: n.summary || '', by: n.byName, ts: n.ts });
  }
  return out.sort((x, y) => y.ts - x.ts);
}

function snapshot(group) {
  return {
    group: { id: group.id, label: group.label },
    agents: [...group.agents.values()].map(publicAgent),
    tasks: publicTasks(group),
    notes: publicNotes(group),
    locks: [...group.locks.entries()].map(([resource, l]) => ({
      resource,
      holder: l.byName,
      ts: l.ts,
    })),
    roles: [...group.roles.entries()].map(([role, r]) => ({ role, holder: r.byName })),
    participants: activeMailboxes(group, null),
    activity: group.broadcasts.slice(-20),
    changes: group.recentChanges.slice(-20),
    stats: group.stats,
  };
}

// ---------------------------------------------------------------------------
// Long-poll waiters
// ---------------------------------------------------------------------------

// Evaluate whether a parked `wait` can now be satisfied. Returns the payload to
// send, or null to keep waiting. `want` selects which channels wake the waiter.
function evalWait(group, w) {
  const result = {};
  let hit = false;

  if (w.want.has('message')) {
    // A mailbox waiter (named participant) drains its mailbox; otherwise the
    // connected instance drains its own socket inbox.
    const mb = w.mailbox ? group.mailboxes.get(w.mailbox) : null;
    const box = w.mailbox ? mb && mb.messages : group.inboxes.get(w.agentId);
    if (box && box.length) {
      result.messages = box.splice(0, box.length); // drain
      hit = true;
    }
  }
  if (w.want.has('task')) {
    // Only wake a worker when there is *ready* work (dependencies satisfied),
    // so it doesn't spin on blocked tasks.
    const ready = group.tasks.filter((t) => taskReady(group, t));
    if (ready.length) {
      result.tasks = ready.map((t) => ({ ...t, ready: true }));
      hit = true;
    }
  }
  if (w.want.has('broadcast')) {
    const fresh = group.broadcasts.filter((b) => b.ts > w.sinceTs);
    if (fresh.length) {
      result.broadcasts = fresh;
      hit = true;
    }
  }
  return hit ? result : null;
}

function settleWaiter(w, payload) {
  if (w.settled) return;
  w.settled = true;
  clearTimeout(w.timer);
  w.group.waiters.delete(w);
  if (w.connState.waiters) w.connState.waiters.delete(w);
  reply(w.connState.sock, w.id, { ok: true, ...payload });
}

// Re-check every waiter in a group after a state change. Anything satisfiable
// is resolved immediately; the rest keep parking.
function pumpWaiters(group) {
  for (const w of [...group.waiters]) {
    const payload = evalWait(group, w);
    if (payload) settleWaiter(w, payload);
  }
}

// ---------------------------------------------------------------------------
// Messaging
// ---------------------------------------------------------------------------

function deliver(group, agentId, message) {
  let box = group.inboxes.get(agentId);
  if (!box) {
    box = [];
    group.inboxes.set(agentId, box);
  }
  box.push(message);
  if (box.length > MAX_INBOX) box.splice(0, box.length - MAX_INBOX);
}

function findAgent(group, idOrName) {
  if (group.agents.has(idOrName)) return group.agents.get(idOrName);
  for (const a of group.agents.values()) {
    if (a.name === idOrName) return a;
  }
  return null;
}

// Named, socket-less participants: a way for actors that don't hold their own
// connection (subagents spawned inside one session, scripts, other tools) to
// have a distinct identity with its own inbox. Keyed by name, kept alive by use,
// reaped when idle.
function getMailbox(group, name) {
  let m = group.mailboxes.get(name);
  if (!m) {
    m = { messages: [], lastSeen: C.now() };
    group.mailboxes.set(name, m);
  }
  return m;
}

function deliverMailbox(group, name, message) {
  const m = getMailbox(group, name);
  m.messages.push(message);
  if (m.messages.length > MAX_INBOX) m.messages.splice(0, m.messages.length - MAX_INBOX);
}

function touchMailbox(group, name) {
  if (name) getMailbox(group, name).lastSeen = C.now();
}

function activeMailboxes(group, exceptName) {
  const nowTs = C.now();
  const out = [];
  for (const [name, m] of group.mailboxes) {
    if (name === exceptName) continue;
    if (nowTs - m.lastSeen > ACTIVE_MAILBOX_MS) continue;
    out.push({ name, kind: 'sub', lastSeen: m.lastSeen, pending: m.messages.length });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Operation handlers. Each returns a plain object (merged into the ok reply)
// or throws Error (becomes an error reply). `wait` is handled separately
// because it may defer its reply.
// ---------------------------------------------------------------------------

const OPS = {
  register(msg, cs) {
    const { agent } = msg;
    if (!agent || !agent.group) throw new Error('register requires agent.group');
    const group = getGroup(agent.group, agent.groupLabel);

    // Disambiguate duplicate display names within a group.
    let name = agent.name || agent.id;
    const taken = new Set([...group.agents.values()].map((a) => a.name));
    if (taken.has(name)) {
      let i = 2;
      while (taken.has(`${name}#${i}`)) i++;
      name = `${name}#${i}`;
    }

    const rec = {
      id: agent.id,
      name,
      cwd: agent.cwd || '',
      pid: agent.pid || 0,
      client: (agent.client || '').slice(0, 40),
      model: (agent.model || '').slice(0, 60),
      status: 'idle',
      inputChannel: agent.inputChannel || null, // set => remote-controllable via dispatch
      capabilities: Array.isArray(agent.capabilities) ? agent.capabilities.slice(0, 32) : [],
      currentTask: null,
      joinedAt: C.now(),
      lastSeen: C.now(),
      connId: cs.id,
    };
    group.agents.set(agent.id, rec);
    group.stats.peakAgents = Math.max(group.stats.peakAgents, group.agents.size);
    group.inboxes.set(agent.id, group.inboxes.get(agent.id) || []);
    // Learn the real project directory from the first registrant and begin
    // watching it for external changes.
    if (!group.dir && agent.cwd) group.dir = agent.cwd;
    ensureWatcher(group);
    cs.agentId = agent.id;
    cs.groupId = group.id;
    lastAgentSeenAt = C.now();

    // Tell the existing members someone joined.
    broadcastSystem(group, agent.id, `${name} joined the hive`);

    log(`register ${name} (${agent.id}) in ${group.label} [${group.id}] — ${group.agents.size} online`);
    return { self: publicAgent(rec), snapshot: snapshot(group) };
  },

  heartbeat(msg, cs) {
    const a = currentAgent(cs);
    if (a) {
      a.lastSeen = C.now();
      if (msg.status) a.status = String(msg.status).slice(0, 80);
    }
    return {};
  },

  presence(msg, cs) {
    const a = currentAgent(cs);
    if (a) {
      if (msg.status) a.status = String(msg.status).slice(0, 80);
      a.lastSeen = C.now();
    }
    return {};
  },

  unregister(msg, cs) {
    cleanup(cs, 'unregister');
    return {};
  },

  whoami(msg, cs) {
    const g = requireGroup(msg, cs);
    const a = currentAgent(cs);
    return {
      self: a ? publicAgent(a) : null,
      group: { id: g.id, label: g.label },
      peers: peersOf(g, cs.agentId),
      participants: activeMailboxes(g, msg.as),
    };
  },

  peers(msg, cs) {
    const g = requireGroup(msg, cs);
    return { peers: peersOf(g, cs.agentId), participants: activeMailboxes(g, msg.as) };
  },

  // Resolve a target's terminal input channel for `dispatch`. Returns the raw
  // channel only when the target opted in (registered one). Same-user machine,
  // so exposing the channel to a peer is fine; the consent gate is the target
  // having set HIVEMIND_ALLOW_DISPATCH=1.
  get_channel(msg, cs) {
    const g = requireGroup(msg, cs);
    const target = findAgent(g, msg.to);
    if (!target) return { found: false };
    if (target.id === cs.agentId) return { found: true, self: true, name: target.name };
    return { found: true, self: false, name: target.name, channel: target.inputChannel || null };
  },

  send(msg, cs) {
    const g = requireGroup(msg, cs);
    if (!msg.to) throw new Error('send requires a recipient (to)');
    const target = findAgent(g, msg.to);
    const message = {
      id: C.genId('m'),
      from: cs.agentId,
      fromName: actorName(msg, cs),
      to: target ? target.id : msg.to,
      kind: msg.kind || 'chat',
      body: msg.body,
      ts: C.now(),
    };
    // A connected instance -> its socket inbox; otherwise a named mailbox (a
    // subagent / script / any named participant).
    if (target) {
      deliver(g, target.id, message);
    } else {
      deliverMailbox(g, msg.to, message);
    }
    g.stats.messages++;
    touchMailbox(g, msg.as); // keep the sender's named identity alive
    pumpWaiters(g);
    return { delivered: true, to: target ? target.name : msg.to };
  },

  broadcast(msg, cs) {
    const g = requireGroup(msg, cs);
    const fromName = actorName(msg, cs);
    const mk = (to) => ({
      id: C.genId('m'),
      from: cs.agentId,
      fromName,
      to,
      kind: msg.kind || 'chat',
      body: msg.body,
      ts: C.now(),
    });
    let n = 0;
    for (const a of g.agents.values()) {
      if (a.id === cs.agentId) continue;
      deliver(g, a.id, mk(a.id));
      n++;
    }
    // Also reach active named participants (e.g. sibling subagents), minus self.
    for (const p of activeMailboxes(g, msg.as)) {
      deliverMailbox(g, p.name, mk(p.name));
      n++;
    }
    pushBroadcastFeed(g, fromName, msg.body);
    g.stats.broadcasts++;
    touchMailbox(g, msg.as);
    pumpWaiters(g);
    return { delivered: n };
  },

  inbox(msg, cs) {
    const g = requireGroup(msg, cs);
    if (msg.as) {
      // Drain a named participant's mailbox (a subagent checking its messages).
      const m = getMailbox(g, msg.as);
      m.lastSeen = C.now();
      return { messages: m.messages.splice(0, m.messages.length) };
    }
    const box = g.inboxes.get(cs.agentId) || [];
    const messages = box.splice(0, box.length);
    return { messages };
  },

  // Shared context blackboard ------------------------------------------------
  share(msg, cs) {
    const g = requireGroup(msg, cs);
    if (!msg.key) throw new Error('share requires key');
    const who = actorName(msg, cs);
    g.notes.set(msg.key, {
      value: msg.value,
      summary: msg.summary || '',
      by: cs.agentId,
      byName: who,
      ts: C.now(),
    });
    pushBroadcastFeed(g, who, `shared context "${msg.key}"`, 'context');
    schedulePersist(g);
    pumpWaiters(g);
    return { key: msg.key };
  },

  recall(msg, cs) {
    const g = requireGroup(msg, cs);
    const n = g.notes.get(msg.key);
    if (!n) return { found: false };
    return {
      found: true,
      key: msg.key,
      value: n.value,
      summary: n.summary,
      by: n.byName,
      ts: n.ts,
    };
  },

  list_notes(msg, cs) {
    const g = requireGroup(msg, cs);
    return { notes: publicNotes(g) };
  },

  // Task board ---------------------------------------------------------------
  task_post(msg, cs) {
    const g = requireGroup(msg, cs);
    if (!msg.title) throw new Error('task_post requires title');
    const known = new Set(g.tasks.map((t) => t.id));
    const deps = Array.isArray(msg.deps) ? msg.deps.filter((d) => known.has(d)) : [];
    const task = {
      id: `t${++g.taskSeq}`,
      title: String(msg.title).slice(0, 1000),
      detail: msg.detail || '',
      status: 'open', // open | claimed | in_progress | done | failed
      priority: Number(msg.priority) || 0,
      tags: Array.isArray(msg.tags) ? msg.tags.slice(0, 16).map(String) : [],
      deps,
      by: actorName(msg, cs),
      claimedBy: null,
      createdAt: C.now(),
      updatedAt: C.now(),
      log: [],
    };
    g.tasks.push(task);
    g.stats.tasksPosted++;
    pruneTasks(g);
    const depNote = deps.length ? ` (after ${deps.join(', ')})` : '';
    pushBroadcastFeed(g, task.by, `posted task ${task.id}: ${task.title}${depNote}`, 'task');
    schedulePersist(g);
    pumpWaiters(g);
    return { task: { ...task, ready: taskReady(g, task), blockedBy: unmetDeps(g, task) } };
  },

  task_list(msg, cs) {
    const g = requireGroup(msg, cs);
    return { tasks: publicTasks(g) };
  },

  task_claim(msg, cs) {
    const g = requireGroup(msg, cs);
    if (!msg.task_id) {
      // No id given -> behave like task_next (smart pick).
      const a = currentAgent(cs);
      const pick = bestReadyTask(g, a ? a.capabilities : msg.capabilities || []);
      if (!pick) return { task: null, reason: 'no ready task available' };
      return claimTask(g, cs, pick.id, msg.as);
    }
    return claimTask(g, cs, msg.task_id, msg.as);
  },

  // Smart claim: atomically grab the best ready task for this instance (highest
  // priority, capability-matched, oldest). One call replaces list+pick+claim.
  task_next(msg, cs) {
    const g = requireGroup(msg, cs);
    const a = currentAgent(cs);
    const pick = bestReadyTask(g, a ? a.capabilities : msg.capabilities || []);
    if (!pick) return { task: null, reason: 'no ready task available' };
    return claimTask(g, cs, pick.id, msg.as);
  },

  task_update(msg, cs) {
    const g = requireGroup(msg, cs);
    const a = currentAgent(cs);
    const who = actorName(msg, cs);
    const task = g.tasks.find((t) => t.id === msg.task_id);
    if (!task) throw new Error(`no task ${msg.task_id}`);
    const valid = ['open', 'claimed', 'in_progress', 'done', 'failed'];
    if (msg.status && !valid.includes(msg.status)) {
      throw new Error(`invalid status "${msg.status}"`);
    }
    if (msg.status) {
      task.status = msg.status;
      if (msg.status === 'open') task.claimedBy = null;
      // Auto-presence: clear the worker's "current task" when it finishes.
      if ((msg.status === 'done' || msg.status === 'failed') && a && a.currentTask === task.id) {
        a.currentTask = null;
        a.status = 'idle';
      }
    }
    task.updatedAt = C.now();
    if (msg.note || msg.status) {
      task.log.push({ ts: C.now(), by: who, note: msg.note || `-> ${msg.status}` });
    }
    pushBroadcastFeed(g, who, `task ${task.id} ${task.status}${msg.note ? `: ${msg.note}` : ''}`, 'task');
    schedulePersist(g);
    pumpWaiters(g); // a completed dep may unblock other tasks -> wake workers
    return { task: { ...task, ready: taskReady(g, task) } };
  },

  // Mirror an instance's native task/todo list onto the board so it fills from
  // the planning agents already do — no new habit, no token cost (hook-driven).
  // Mirrored tasks are owned by a session, are never claimable by others, and are
  // not persisted. kind: 'create' | 'update' | 'list'.
  mirror_tasks(msg, cs) {
    const g = getGroup(msg.group, msg.groupLabel);
    const owner = msg.sessionKey;
    if (!owner) return {};
    const who = msg.who || owner;
    const mapStatus = (s) =>
      ({ pending: 'open', in_progress: 'in_progress', completed: 'done' }[s] || 'open');
    const findM = (nativeId) => g.tasks.find((t) => t.mirrored && t.owner === owner && t.nativeId === nativeId);
    const removeM = (nativeId) => {
      const i = g.tasks.findIndex((t) => t.mirrored && t.owner === owner && t.nativeId === nativeId);
      if (i >= 0) g.tasks.splice(i, 1);
    };
    const upsert = (item) => {
      const nativeId = String(item.nativeId || '');
      if (!nativeId) return;
      if (item.status === 'deleted') return removeM(nativeId);
      let t = findM(nativeId);
      if (!t) {
        t = {
          id: `~m${++g.taskSeq}`,
          title: '',
          detail: '',
          status: 'open',
          priority: 0,
          tags: [],
          deps: [],
          by: who,
          claimedBy: who,
          mirrored: true,
          owner,
          nativeId,
          createdAt: C.now(),
          updatedAt: C.now(),
          log: [],
        };
        g.tasks.push(t);
      }
      if (item.subject) t.title = String(item.subject).slice(0, 1000);
      if (item.status) t.status = mapStatus(item.status);
      if (Array.isArray(item.blockedBy)) t.blockedByNative = item.blockedBy.map(String);
      t.updatedAt = C.now();
    };

    if (msg.kind === 'list') {
      const items = Array.isArray(msg.items) ? msg.items : [];
      const keep = new Set(items.map((it) => String(it.nativeId || '')));
      // Reconcile: drop this owner's mirrored tasks no longer in the snapshot.
      for (const t of [...g.tasks]) {
        if (t.mirrored && t.owner === owner && !keep.has(t.nativeId)) removeM(t.nativeId);
      }
      for (const it of items) upsert(it);
    } else {
      upsert(msg.item || {});
    }
    pruneTasks(g);
    return { ok: true };
  },

  // Drop all mirrored tasks for a session (its window closed).
  mirror_clear(msg, cs) {
    const g = msg.group ? getGroup(msg.group, msg.groupLabel) : groups.get(cs.groupId);
    if (!g || !msg.sessionKey) return {};
    g.tasks = g.tasks.filter((t) => !(t.mirrored && t.owner === msg.sessionKey));
    return {};
  },

  // Advisory locks -----------------------------------------------------------
  lock(msg, cs) {
    const g = requireGroup(msg, cs);
    const a = currentAgent(cs);
    const who = a ? a.name : cs.agentId;
    if (!msg.resource) throw new Error('lock requires resource');
    expireLocks(g);
    const existing = g.locks.get(msg.resource);
    if (existing && existing.by !== cs.agentId) {
      return { acquired: false, holder: existing.byName, since: existing.ts };
    }
    g.locks.set(msg.resource, {
      by: cs.agentId,
      byName: who,
      ts: C.now(),
      ttlMs: Math.min(Number(msg.ttl_ms) || DEFAULT_LOCK_TTL_MS, MAX_LOCK_TTL_MS),
    });
    return { acquired: true, resource: msg.resource };
  },

  unlock(msg, cs) {
    const g = requireGroup(msg, cs);
    const existing = g.locks.get(msg.resource);
    if (existing && existing.by === cs.agentId) {
      g.locks.delete(msg.resource);
      return { released: true };
    }
    return { released: false, reason: existing ? 'held by another agent' : 'not locked' };
  },

  // Cross-hook edit-collision detection (keyed by session, not agent id, so the
  // PreToolUse hook can use it without knowing the MCP agent id).
  edit_intent(msg, cs) {
    const g = getGroup(msg.group, msg.groupLabel);
    const file = msg.file;
    if (!file) return { conflict: null };
    const nowTs = C.now();
    // Drop stale intents.
    for (const [f, rec] of g.editIntents) {
      if (nowTs - rec.ts > EDIT_INTENT_WINDOW_MS) g.editIntents.delete(f);
    }
    const prior = g.editIntents.get(file);
    let conflict = null;
    if (prior && prior.sessionKey !== msg.sessionKey && nowTs - prior.ts <= EDIT_INTENT_WINDOW_MS) {
      conflict = { who: prior.who, agoMs: nowTs - prior.ts };
    }
    g.editIntents.set(file, { sessionKey: msg.sessionKey, who: msg.who || 'a peer', ts: nowTs });
    return { conflict };
  },

  // Turn/activity pulse from hooks. Lets the hive (and dashboard) reflect that
  // instances are actively being used even when they aren't calling hive tools
  // or editing files — a turn is a unit of "this instance just did work".
  note_activity(msg, cs) {
    const g = getGroup(msg.group, msg.groupLabel);
    if (msg.kind === 'turn') g.stats.turns++;
    if (msg.sessionKey) {
      g.sessionActivity.set(msg.sessionKey, { label: msg.label || '', ts: C.now() });
      // Keep the session-activity map from growing without bound.
      if (g.sessionActivity.size > 256) {
        const oldest = [...g.sessionActivity.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
        if (oldest) g.sessionActivity.delete(oldest[0]);
      }
    }
    return {};
  },

  // Leader election ----------------------------------------------------------
  // First caller to claim a named role wins and holds it until they disconnect
  // or release it. Lets a fleet pick exactly one instance for setup, schema
  // migrations, dependency installs — anything that must happen once.
  elect(msg, cs) {
    const g = requireGroup(msg, cs);
    const a = currentAgent(cs);
    const who = a ? a.name : cs.agentId;
    const role = msg.role || 'leader';
    const held = g.roles.get(role);
    if (held && held.by !== cs.agentId && g.agents.has(held.by)) {
      return { leader: false, role, holder: held.byName };
    }
    g.roles.set(role, { by: cs.agentId, byName: who, ts: C.now() });
    return { leader: true, role, holder: who };
  },

  release_role(msg, cs) {
    const g = requireGroup(msg, cs);
    const role = msg.role || 'leader';
    const held = g.roles.get(role);
    if (held && held.by === cs.agentId) {
      g.roles.delete(role);
      return { released: true };
    }
    return { released: false };
  },

  // Shared repo-change feed --------------------------------------------------
  // Fed by the PostToolUse hook so every instance can see which files its peers
  // just edited — context sharing and a second line of collision defence.
  record_change(msg, cs) {
    const g = getGroup(msg.group, msg.groupLabel);
    if (!msg.file) return {};
    g.recentChanges.push({
      who: msg.who || 'a peer',
      file: msg.file,
      tool: msg.tool || 'edit',
      ts: C.now(),
    });
    if (g.recentChanges.length > MAX_CHANGES) {
      g.recentChanges.splice(0, g.recentChanges.length - MAX_CHANGES);
    }
    // Remember this edit so the FS watcher can distinguish the agent's own write
    // from a genuinely external change to the same file.
    g.recentAgentEdits.set(msg.file, C.now());
    g.stats.edits++;
    return {};
  },

  list_changes(msg, cs) {
    const g = requireGroup(msg, cs);
    const since = Number(msg.sinceTs) || 0;
    return { changes: g.recentChanges.filter((c) => c.ts > since) };
  },

  // Operator broadcast: lets a human at the monitor speak to a whole hive
  // without being a registered agent. Reaches every instance's inbox + feed.
  say(msg, cs) {
    const g = getGroup(msg.group, msg.groupLabel);
    const from = msg.from || 'operator';
    let n = 0;
    for (const a of g.agents.values()) {
      deliver(g, a.id, {
        id: C.genId('m'),
        from: 'operator',
        fromName: from,
        to: a.id,
        kind: 'operator',
        body: msg.body,
        ts: C.now(),
      });
      n++;
    }
    pushBroadcastFeed(g, from, msg.body, 'operator');
    g.stats.broadcasts++;
    pumpWaiters(g);
    return { delivered: n };
  },

  // Read-only views ----------------------------------------------------------
  status(msg, cs) {
    const hub = {
      startedAt: HUB_STARTED_AT,
      pid: process.pid,
      protocol: C.PROTOCOL_VERSION,
      now: C.now(),
    };
    if (msg.group) {
      const g = groups.get(msg.group);
      return { hub, groups: g ? [snapshot(g)] : [] };
    }
    return { hub, groups: [...groups.values()].map(snapshot) };
  },

  // Compact summary for hook context injection.
  digest(msg, cs) {
    const g = groups.get(msg.group);
    const nowTs = C.now();
    if (!g) return { nowTs, peers: [], openTasks: 0, claimedTasks: 0, recentBroadcasts: [] };
    const since = Number(msg.sinceTs) || 0;
    return {
      nowTs,
      label: g.label,
      peers: [...g.agents.values()].map((a) => ({ name: a.name, status: a.status, cwd: a.cwd })),
      openTasks: g.tasks.filter((t) => t.status === 'open').length,
      claimedTasks: g.tasks.filter((t) => t.status === 'claimed' || t.status === 'in_progress').length,
      recentBroadcasts: g.broadcasts
        .filter((b) => b.ts > since)
        .slice(-6)
        .map((b) => ({ fromName: b.fromName, body: b.body, kind: b.kind, ts: b.ts })),
      notes: publicNotes(g).slice(0, 8),
    };
  },

  shutdown() {
    log('shutdown requested via control op');
    setTimeout(() => process.exit(0), 50);
    return { ok: true };
  },
};

// ---------------------------------------------------------------------------
// Helpers used by the op handlers
// ---------------------------------------------------------------------------

function currentAgent(cs) {
  const g = groups.get(cs.groupId);
  return g ? g.agents.get(cs.agentId) : null;
}

// Most ops act on the caller's registered group. Allow an explicit group in the
// message (used by hook-style one-shot clients that never register).
function requireGroup(msg, cs) {
  if (cs.groupId && groups.has(cs.groupId)) return groups.get(cs.groupId);
  if (msg.group) return getGroup(msg.group, msg.groupLabel);
  throw new Error('not registered to a group');
}

function pushBroadcastFeed(group, fromName, body, kind) {
  group.broadcasts.push({ fromName, body, kind: kind || 'chat', ts: C.now() });
  if (group.broadcasts.length > MAX_BROADCASTS) {
    group.broadcasts.splice(0, group.broadcasts.length - MAX_BROADCASTS);
  }
}

// System events (joins/leaves) are PASSIVE: they go only to the ambient feed —
// shown in the per-turn digest and the monitor — and are never delivered to an
// inbox or used to wake a `wait`. Nothing the hive does automatically rouses an
// instance; only an explicit peer send/broadcast does.
function broadcastSystem(group, _exceptId, body) {
  pushBroadcastFeed(group, 'hive', body, 'system');
}

function expireLocks(group) {
  const nowTs = C.now();
  for (const [res, l] of group.locks) {
    if (nowTs - l.ts > l.ttlMs) group.locks.delete(res);
  }
}

// Keep the task board bounded by discarding the oldest *completed* work first.
// Active work (open / claimed / in_progress) is never pruned, so a busy hive
// can't lose live tasks no matter how much history accumulates.
function pruneTasks(group) {
  if (group.tasks.length <= MAX_TASKS) return;
  const live = group.tasks.filter((t) => t.status !== 'done' && t.status !== 'failed');
  const finished = group.tasks.filter((t) => t.status === 'done' || t.status === 'failed');
  const keepFinished = Math.max(0, MAX_TASKS - live.length);
  const trimmed = finished.slice(Math.max(0, finished.length - keepFinished));
  // Preserve original ordering by id (creation order).
  group.tasks = [...live, ...trimmed].sort(
    (a, b) => Number(a.id.slice(1)) - Number(b.id.slice(1))
  );
}

// ---------------------------------------------------------------------------
// Filesystem watching: be aware of EXTERNAL changes (builds, git, edits made in
// another editor) without ever invoking an LLM. Events are recorded as passive
// state and surfaced on a turn the agent was already taking.
// ---------------------------------------------------------------------------

function ensureWatcher(group) {
  if (!WATCH_ENABLED || group.watcher || !group.dir) return;
  let exists = false;
  try {
    exists = fs.statSync(group.dir).isDirectory();
  } catch (_) {
    exists = false;
  }
  if (!exists) return; // e.g. synthetic test groups with no real directory
  const w = createProjectWatcher(group.dir, {
    ignore: WATCH_IGNORE,
    onBatch: (paths, overflow) => handleFsBatch(group, paths, overflow),
    onError: (err) => {
      log(`watch disabled for ${group.label}: ${err.message}`);
      group.watcher = null;
    },
  });
  group.watcher = w;
  log(`watching ${group.dir} for ${group.label} [${group.id}]`);
}

function closeWatcher(group) {
  if (group.watcher) {
    try {
      group.watcher.close();
    } catch (_) {
      /* ignore */
    }
    group.watcher = null;
  }
}

function handleFsBatch(group, paths, overflow) {
  const nowTs = C.now();
  // Drop changes an agent just made itself (already tracked as edits), so the
  // FS feed shows only external changes — the genuinely useful signal.
  for (const [p, ts] of group.recentAgentEdits) {
    if (nowTs - ts > AGENT_EDIT_DEDUP_MS) group.recentAgentEdits.delete(p);
  }
  const external = paths.filter((p) => {
    const ts = group.recentAgentEdits.get(p);
    return !(ts && nowTs - ts < AGENT_EDIT_DEDUP_MS);
  });
  if (!external.length) return;

  for (const p of external.slice(0, 60)) {
    group.recentChanges.push({ who: 'filesystem', file: p, tool: 'fs', ts: nowTs });
  }
  if (group.recentChanges.length > MAX_CHANGES) {
    group.recentChanges.splice(0, group.recentChanges.length - MAX_CHANGES);
  }
  group.stats.fsChanges += external.length;

  const names = external.slice(0, 4).map((p) => path.basename(p));
  const extra = external.length - names.length;
  const body =
    `${external.length}${overflow ? '+' : ''} file(s) changed externally: ` +
    `${names.join(', ')}${extra > 0 ? ` (+${extra} more)` : ''}`;
  // Purely passive: the summary goes to the ambient feed only. Agents see it in
  // their next-turn digest or via the `changes` tool — never pushed, never waking
  // anyone, never costing a token until a turn the user already started.
  pushBroadcastFeed(group, 'filesystem', body, 'fs');
}

function handleWait(cs, msg) {
  const g = requireGroup(msg, cs);
  const want = new Set(
    Array.isArray(msg.want) && msg.want.length ? msg.want : ['message']
  );
  const timeoutMs = Math.min(Math.max(Number(msg.timeout_ms) || 30000, 1000), MAX_WAIT_MS);
  const w = {
    id: msg.id,
    agentId: cs.agentId,
    group: g,
    connState: cs,
    want,
    mailbox: msg.as || null, // wait on a named participant's mailbox instead of the socket inbox
    sinceTs: Number(msg.sinceTs) || C.now(),
    settled: false,
    timer: null,
  };
  if (w.mailbox) touchMailbox(g, w.mailbox); // a waiting subagent counts as present
  // Fast path: already satisfiable.
  const immediate = evalWait(g, w);
  if (immediate) {
    reply(cs.sock, msg.id, { ok: true, ...immediate });
    return;
  }
  w.timer = setTimeout(() => settleWaiter(w, { timeout: true }), timeoutMs);
  g.waiters.add(w);
  cs.waiters.add(w);
}

// Synchronization barrier: every participant calls `barrier` with the same
// name and party count and blocks until all have arrived, then they release
// together. The backbone for lockstep phases across a fleet ("everyone finish
// scaffolding before anyone starts wiring").
function handleBarrier(cs, msg) {
  const g = requireGroup(msg, cs);
  const name = msg.name || 'sync';
  const parties = Math.max(1, Number(msg.parties) || 2);
  const timeoutMs = Math.min(Math.max(Number(msg.timeout_ms) || 60000, 1000), MAX_BARRIER_MS);

  let b = g.barriers.get(name);
  if (!b) {
    b = { name, parties, arrived: new Map() };
    g.barriers.set(name, b);
  }
  b.parties = parties; // last writer wins; participants agree by convention

  const arrival = { id: msg.id, cs, settled: false, timer: null };
  // Replace any previous arrival from this same agent (e.g. a retry).
  const prev = b.arrived.get(cs.agentId);
  if (prev) clearTimeout(prev.timer);
  b.arrived.set(cs.agentId, arrival);

  const release = (payload) => {
    for (const [aid, ar] of b.arrived) {
      if (ar.settled) continue;
      ar.settled = true;
      clearTimeout(ar.timer);
      reply(ar.cs.sock, ar.id, { ok: true, ...payload });
    }
    g.barriers.delete(name);
  };

  if (b.arrived.size >= parties) {
    release({ released: true, name, parties, arrived: b.arrived.size });
    return;
  }
  arrival.timer = setTimeout(() => {
    if (arrival.settled) return;
    arrival.settled = true;
    b.arrived.delete(cs.agentId);
    if (b.arrived.size === 0) g.barriers.delete(name);
    reply(cs.sock, msg.id, { ok: true, released: false, timeout: true, name, arrived: b.arrived.size, parties });
  }, timeoutMs);
}

// ---------------------------------------------------------------------------
// Connection lifecycle
// ---------------------------------------------------------------------------

function reply(sock, id, payload) {
  if (id == null) return; // notifications get no reply
  C.sendLine(sock, { id, ...payload });
}

function onConnection(sock) {
  const cs = {
    id: C.genId('c'),
    sock,
    agentId: null,
    groupId: null,
    waiters: new Set(),
  };
  const decode = C.lineDecoder((msg) => {
    try {
      if (msg.op === 'wait') {
        handleWait(cs, msg);
        return;
      }
      if (msg.op === 'barrier') {
        handleBarrier(cs, msg);
        return;
      }
      const fn = OPS[msg.op];
      if (!fn) {
        reply(sock, msg.id, { ok: false, error: `unknown op: ${msg.op}` });
        return;
      }
      // Touch liveness on any traffic from a registered agent.
      const a = currentAgent(cs);
      if (a) a.lastSeen = C.now();
      const result = fn(msg, cs) || {};
      reply(sock, msg.id, { ok: true, ...result });
    } catch (e) {
      reply(sock, msg.id, { ok: false, error: e.message || String(e) });
    }
  });

  sock.on('data', (d) => decode(d.toString('utf8')));
  sock.on('error', () => cleanup(cs, 'error'));
  sock.on('close', () => cleanup(cs, 'close'));
}

// Remove an agent and everything tied to its connection. Driven by socket
// close, so it covers crashes and kill -9 just as well as clean exits.
function cleanup(cs, reason) {
  // Cancel any parked waiters on this connection.
  for (const w of cs.waiters) {
    w.settled = true;
    clearTimeout(w.timer);
    if (w.group) w.group.waiters.delete(w);
  }
  cs.waiters.clear();

  if (!cs.groupId) return;
  const g = groups.get(cs.groupId);
  if (!g) return;
  const a = g.agents.get(cs.agentId);
  if (!a || a.connId !== cs.id) return; // already replaced by a reconnect

  g.agents.delete(cs.agentId);
  g.inboxes.delete(cs.agentId);

  // Release the departed agent's locks and elected roles.
  for (const [res, l] of g.locks) {
    if (l.by === cs.agentId) g.locks.delete(res);
  }
  for (const [role, r] of g.roles) {
    if (r.by === cs.agentId) g.roles.delete(role);
  }
  // Drop it from any barrier it was waiting at, so peers aren't stuck forever.
  for (const [name, b] of g.barriers) {
    const ar = b.arrived.get(cs.agentId);
    if (ar) {
      clearTimeout(ar.timer);
      b.arrived.delete(cs.agentId);
      if (b.arrived.size === 0) g.barriers.delete(name);
    }
  }
  // Reopen any work it had claimed but not finished, so a peer can take over.
  let reopened = false;
  for (const t of g.tasks) {
    if (t.claimedBy === a.name && (t.status === 'claimed' || t.status === 'in_progress')) {
      t.status = 'open';
      t.claimedBy = null;
      t.updatedAt = C.now();
      t.log.push({ ts: C.now(), by: 'hive', note: `reopened (${a.name} left)` });
      reopened = true;
    }
  }
  if (reopened) schedulePersist(g);
  broadcastSystem(g, cs.agentId, `${a.name} left the hive`);
  // Only wake waiting workers if a departure actually reopened work (a pull-side
  // task event they opted into) — never for the bare presence change.
  if (reopened) pumpWaiters(g);
  // No one left to react to changes: stop watching (reopens when an agent
  // rejoins). Watchers are also a finite OS resource, so don't leak them.
  if (g.agents.size === 0) closeWatcher(g);
  log(`cleanup ${a.name} (${reason}) — ${g.agents.size} left in ${g.label}`);

  // Drop empty groups from memory so it doesn't grow with abandoned projects.
  // Durable state stays on disk and rehydrates if the group comes back.
  if (g.agents.size === 0 && g.tasks.length === 0 && g.notes.size === 0) {
    if (g.persistTimer) {
      clearTimeout(g.persistTimer);
      persistNow(g);
    }
    groups.delete(g.id);
  }
  if (totalAgents() === 0) lastAgentSeenAt = C.now();
}

// ---------------------------------------------------------------------------
// Periodic maintenance: reap silent agents, expire locks, idle shutdown.
// ---------------------------------------------------------------------------

function sweep() {
  const nowTs = C.now();
  for (const g of groups.values()) {
    expireLocks(g);
    for (const a of [...g.agents.values()]) {
      if (nowTs - a.lastSeen > AGENT_STALE_MS) {
        log(`reaping stale agent ${a.name} (silent ${Math.round((nowTs - a.lastSeen) / 1000)}s)`);
        // Synthesize a connection-state to reuse cleanup().
        cleanup({ id: a.connId, agentId: a.id, groupId: g.id, waiters: new Set() }, 'stale');
      }
    }
    // Reap idle, empty named mailboxes (a subagent that finished and went away).
    for (const [name, m] of g.mailboxes) {
      if (!m.messages.length && nowTs - m.lastSeen > MAILBOX_TTL_MS) g.mailboxes.delete(name);
    }
    // Drop mirrored tasks from sessions that went silent (no SessionEnd fired).
    const before = g.tasks.length;
    g.tasks = g.tasks.filter((t) => !(t.mirrored && nowTs - (t.updatedAt || 0) > MIRROR_TTL_MS));
    if (g.tasks.length !== before) { /* pruned stale mirrored tasks */ }
  }
  if (totalAgents() === 0 && nowTs - lastAgentSeenAt > IDLE_SHUTDOWN_MS) {
    log('idle with no agents — shutting down');
    gracefulExit();
  }
}

function gracefulExit() {
  try {
    if (process.platform !== 'win32') fs.unlinkSync(C.socketPath());
  } catch (_) {
    /* ignore */
  }
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Bootstrap: bind the socket, handling a stale file or a live rival hub.
// ---------------------------------------------------------------------------

function start() {
  const sockPath = C.socketPath();
  const server = net.createServer(onConnection);

  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Either a live hub already owns the socket, or it's a stale file from a
      // crashed hub. Probe by connecting: success -> defer to the live one;
      // failure -> remove the stale file and retry.
      const probe = net.connect(sockPath);
      probe.on('connect', () => {
        probe.destroy();
        log('another hub is already running — exiting');
        process.exit(0);
      });
      probe.on('error', () => {
        if (process.platform !== 'win32') {
          try {
            fs.unlinkSync(sockPath);
          } catch (_) {
            /* ignore */
          }
        }
        setTimeout(() => server.listen(sockPath), 50);
      });
    } else {
      log(`fatal server error: ${err.message}`);
      process.exit(1);
    }
  });

  server.listen(sockPath, () => {
    try {
      if (process.platform !== 'win32') fs.chmodSync(sockPath, 0o600);
    } catch (_) {
      /* ignore */
    }
    log(`listening on ${sockPath} (pid ${process.pid}, protocol v${C.PROTOCOL_VERSION})`);
  });

  setInterval(sweep, SWEEP_MS).unref();

  process.on('SIGTERM', gracefulExit);
  process.on('SIGINT', gracefulExit);
}

start();
