'use strict';

// Shared primitives for the hive: where the hub socket lives, how a working
// directory maps to a project "group", id/name generation, and NDJSON framing.
//
// Everything here is dependency-free and side-effect-free except for the
// directory helpers, which create their target lazily.

const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

// Bump only on incompatible wire-protocol changes. The hub and clients refuse
// to interoperate across mismatched major protocol versions.
const PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// Filesystem locations
// ---------------------------------------------------------------------------

// Durable state (logs, hook cursors). Kept under ~/.claude so it travels with
// the user's Claude config and is easy to find when debugging.
function stateDir() {
  const d = path.join(os.homedir(), '.claude', 'hivemind');
  fs.mkdirSync(d, { recursive: true });
  return d;
}

// Runtime dir for the control socket. Prefer XDG_RUNTIME_DIR (tmpfs, short
// path) so we stay under the ~104-char sun_path limit on macOS/BSD; fall back
// to the OS temp dir. Per-uid so two users on one box never collide.
function runtimeBase() {
  const base = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'u';
  const d = path.join(base, `claude-hivemind-${uid}`);
  try {
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
  } catch (_) {
    /* best effort */
  }
  return d;
}

// The hub's listening address. A Unix domain socket everywhere except Windows,
// which gets a per-user named pipe.
function socketPath() {
  if (process.platform === 'win32') {
    const tag = crypto
      .createHash('sha1')
      .update(os.userInfo().username)
      .digest('hex')
      .slice(0, 8);
    return `\\\\.\\pipe\\claude-hivemind-${tag}`;
  }
  return path.join(runtimeBase(), 'hub.sock');
}

function hubLogPath() {
  return path.join(stateDir(), 'hub.log');
}

function cursorPath(sessionId) {
  const safe = String(sessionId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(stateDir(), `cursor-${safe}.json`);
}

// ---------------------------------------------------------------------------
// Project / group resolution
// ---------------------------------------------------------------------------

// The git work-tree root, or null when the directory isn't inside a repo.
function gitToplevel(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      encoding: 'utf8',
      timeout: 2000,
    }).trim();
    return out || null;
  } catch (_) {
    return null;
  }
}

// The canonical directory a session belongs to. Prefer the git root so that a
// session started in a subdirectory still joins the same hive as one started
// at the repo root. realpath resolves symlinks so /tmp vs /private/tmp on
// macOS don't fork a group.
function resolveProjectDir(startDir) {
  const base = startDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  let real;
  try {
    real = fs.realpathSync(base);
  } catch (_) {
    real = path.resolve(base);
  }
  return gitToplevel(real) || real;
}

// Map a directory to a stable group identity. The id is a short hash so it can
// be used as a map key and printed compactly; the label is the basename for
// humans. Two sessions yield the same group iff they resolve to the same
// project directory — that is the isolation boundary.
function groupFor(startDir) {
  const dir = resolveProjectDir(startDir);
  const id = crypto.createHash('sha1').update(dir).digest('hex').slice(0, 12);
  return { id, label: path.basename(dir) || dir, dir };
}

// ---------------------------------------------------------------------------
// Identity helpers
// ---------------------------------------------------------------------------

function genId(prefix) {
  return `${prefix || 'id'}_${crypto.randomBytes(5).toString('hex')}`;
}

const ADJECTIVES = [
  'swift', 'quiet', 'bright', 'keen', 'bold', 'calm', 'brave', 'clever',
  'nimble', 'lucid', 'sharp', 'steady', 'vivid', 'wry', 'stoic', 'deft',
];
const CREATURES = [
  'otter', 'falcon', 'lynx', 'heron', 'fox', 'raven', 'ibex', 'wolf',
  'marten', 'crane', 'gecko', 'tapir', 'orca', 'finch', 'shrike', 'civet',
];

// A friendly, human-pronounceable handle so agents can address each other
// without copy-pasting hex ids. Collisions within a group are disambiguated by
// the hub at registration time.
function randomName() {
  const a = ADJECTIVES[crypto.randomBytes(1)[0] % ADJECTIVES.length];
  const c = CREATURES[crypto.randomBytes(1)[0] % CREATURES.length];
  return `${a}-${c}`;
}

// ---------------------------------------------------------------------------
// NDJSON framing (newline-delimited JSON over a stream socket)
// ---------------------------------------------------------------------------

// Returns a function you feed string chunks; it invokes onLine(obj) for each
// complete JSON line. Partial lines are buffered across chunks. Malformed
// lines are skipped rather than throwing, so one bad frame can't kill a peer.
function lineDecoder(onLine) {
  let buf = '';
  return (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim() === '') continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch (_) {
        continue;
      }
      onLine(obj);
    }
  };
}

function sendLine(sock, obj) {
  try {
    return sock.write(JSON.stringify(obj) + '\n');
  } catch (_) {
    return false;
  }
}

function now() {
  return Date.now();
}

module.exports = {
  PROTOCOL_VERSION,
  stateDir,
  runtimeBase,
  socketPath,
  hubLogPath,
  cursorPath,
  gitToplevel,
  resolveProjectDir,
  groupFor,
  genId,
  randomName,
  lineDecoder,
  sendLine,
  now,
};
