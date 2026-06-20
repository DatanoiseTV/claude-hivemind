'use strict';

// Client side of the hub protocol. Two flavours:
//
//   PersistentClient - held open for a whole Claude session by the MCP server.
//                      Its live socket is the agent's presence; it heartbeats,
//                      multiplexes many in-flight requests (including long
//                      polls), and transparently reconnects + re-registers if
//                      the hub restarts.
//
//   quickRequest     - a fire-and-forget one-shot used by hooks and the CLI,
//                      which have no long-lived process. Connect, ask, close.
//
// Both will lazily start the hub daemon if it isn't already running.

const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const C = require('./common');

const HUB_SCRIPT = path.join(__dirname, '..', 'hub.js');

// Spawn the hub as a detached, parentless background process. stdout/stderr go
// to a log file for debugging. unref() lets the spawning process exit without
// waiting for (or killing) the hub.
function spawnHub() {
  let out;
  try {
    out = fs.openSync(C.hubLogPath(), 'a');
  } catch (_) {
    out = 'ignore';
  }
  const child = spawn(process.execPath, [HUB_SCRIPT], {
    detached: true,
    stdio: ['ignore', out, out],
    env: process.env,
  });
  child.unref();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// Try to connect once. Resolves with the socket or rejects with the error.
function connectOnce(timeoutMs) {
  return new Promise((resolve, reject) => {
    const sock = net.connect(C.socketPath());
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      sock.destroy();
      reject(new Error('connect timeout'));
    }, timeoutMs);
    sock.once('connect', () => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      resolve(sock);
    });
    sock.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(t);
      reject(err);
    });
  });
}

// Connect, starting the hub if needed and retrying through the brief window
// while it binds its socket.
async function connectStartingHub({ autostart = true, attempts = 30 } = {}) {
  let spawned = false;
  for (let i = 0; i < attempts; i++) {
    try {
      return await connectOnce(1500);
    } catch (err) {
      const transient = err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.message === 'connect timeout';
      if (!transient) throw err;
      if (autostart && !spawned) {
        spawnHub();
        spawned = true;
      } else if (!autostart) {
        throw err;
      }
      await sleep(100 + i * 20);
    }
  }
  throw new Error('could not reach hive hub');
}

// ---------------------------------------------------------------------------
// One-shot request (hooks, CLI)
// ---------------------------------------------------------------------------

async function quickRequest(op, payload = {}, { timeoutMs = 2000, autostart = false } = {}) {
  let sock;
  try {
    sock = autostart ? await connectStartingHub({ autostart: true }) : await connectOnce(timeoutMs);
  } catch (_) {
    return null; // hub unreachable -> caller treats as "hive offline"
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sock.destroy();
      } catch (_) {
        /* ignore */
      }
      resolve(v);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    const decode = C.lineDecoder((obj) => finish(obj));
    sock.on('data', (d) => decode(d.toString('utf8')));
    sock.on('error', () => finish(null));
    C.sendLine(sock, { id: '1', op, ...payload });
  });
}

// ---------------------------------------------------------------------------
// Persistent client (MCP server)
// ---------------------------------------------------------------------------

class PersistentClient {
  constructor({ agent, heartbeatMs = 15000, log = () => {} }) {
    this.agent = agent; // { id, name, group, groupLabel, cwd, pid, model }
    this.heartbeatMs = heartbeatMs;
    this.log = log;
    this.sock = null;
    this.connected = false;
    this.connecting = null; // in-flight ensureConnected() promise
    this.seq = 0;
    this.pending = new Map(); // requestId -> { resolve, reject, timer }
    this.snapshot = null;
    this.heartbeatTimer = null;
    this.closed = false;
  }

  async ensureConnected() {
    if (this.connected) return;
    if (this.connecting) return this.connecting;
    this.connecting = this._connect();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async _connect() {
    const sock = await connectStartingHub({ autostart: true });
    this.sock = sock;
    const decode = C.lineDecoder((obj) => this._onMessage(obj));
    sock.on('data', (d) => decode(d.toString('utf8')));
    sock.on('error', () => {});
    sock.on('close', () => this._onClose());
    this.connected = true;

    // Register (or re-register after a hub restart) and cache the snapshot.
    const res = await this._raw('register', { agent: this.agent }, 5000);
    if (res && res.ok) {
      this.snapshot = res.snapshot;
      this.self = res.self;
    }
    this._startHeartbeat();
    this.log(`connected to hive as ${this.agent.name} (${this.agent.id})`);
  }

  // A single lifetime ticker (idempotent). While connected it heartbeats; while
  // disconnected it reconnects. This is what lets an idle instance rejoin the
  // hive on its own after the hub restarts — presence isn't lost just because
  // the agent isn't actively calling hive tools.
  _startHeartbeat() {
    if (this.heartbeatTimer) return;
    this.heartbeatTimer = setInterval(() => {
      if (this.closed) return;
      if (this.connected) {
        this._raw('heartbeat', {}, 4000).catch(() => {});
      } else {
        this.ensureConnected().catch(() => {});
      }
    }, this.heartbeatMs);
    if (this.heartbeatTimer.unref) this.heartbeatTimer.unref();
  }

  _onClose() {
    this.connected = false;
    // Fail every in-flight request so callers don't hang.
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('hub connection lost'));
    }
    this.pending.clear();
    if (this.closed) return;
    this.log('hub connection lost; reconnecting');
    // Kick a fast reconnect; the lifetime ticker is the backstop. (The ticker is
    // intentionally NOT cleared here, so reconnection continues while idle.)
    setTimeout(() => {
      if (!this.closed && !this.connected) this.ensureConnected().catch(() => {});
    }, 500);
  }

  _onMessage(obj) {
    if (obj.id == null) return; // async events (unused today)
    const p = this.pending.get(obj.id);
    if (!p) return;
    this.pending.delete(obj.id);
    clearTimeout(p.timer);
    p.resolve(obj);
  }

  // Send a request on the current socket without (re)connecting. Used
  // internally where we already know we're connected.
  _raw(op, payload, timeoutMs) {
    return new Promise((resolve, reject) => {
      if (!this.sock || !this.connected) {
        reject(new Error('not connected'));
        return;
      }
      const id = `r${++this.seq}`;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`hub request "${op}" timed out`));
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      C.sendLine(this.sock, { id, op, ...payload });
    });
  }

  // Public request: ensures a connection first, then sends. `timeoutMs` should
  // exceed the server-side timeout for long-poll ops (wait/barrier).
  async request(op, payload = {}, timeoutMs = 8000) {
    await this.ensureConnected();
    const res = await this._raw(op, payload, timeoutMs);
    if (res && res.ok === false) {
      throw new Error(res.error || `hub op "${op}" failed`);
    }
    return res;
  }

  async unregister() {
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    try {
      if (this.connected) await this._raw('unregister', {}, 1500);
    } catch (_) {
      /* best effort */
    }
    try {
      if (this.sock) this.sock.destroy();
    } catch (_) {
      /* ignore */
    }
  }
}

module.exports = { PersistentClient, quickRequest, spawnHub };
