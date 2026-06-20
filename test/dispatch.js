'use strict';

// Verifies `dispatch` — typing a prompt into another instance's terminal.
// Exercises detectInputChannel (the opt-in gate), the hub's get_channel routing
// (self refused, non-dispatchable returns no channel), and a REAL injection into
// a tmux pane (proving text + Enter actually land). The tmux round-trip
// self-skips if tmux isn't installed. Usage: node test/dispatch.js

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');

const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedisp-'));
process.env.XDG_RUNTIME_DIR = rt;

const C = require('../src/lib/common');
const { PersistentClient, quickRequest } = require('../src/lib/hub-client');
const { detectInputChannel, inject } = require('../src/lib/inject');

let passed = 0;
function assert(cond, name) {
  if (!cond) throw new Error(`FAILED: ${name}`);
  passed++;
  console.log(`  ok  ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const group = { id: 'g_disp', label: 'disp', dir: '/tmp/disp' };
const mk = (name, extra) => ({ id: C.genId('a'), name, group: group.id, groupLabel: group.label, cwd: group.dir, pid: process.pid, model: '', ...extra });

function tmuxAvailable() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch (_) {
    return false;
  }
}

async function main() {
  // --- opt-in gate (no tmux needed) ---
  assert(detectInputChannel({}) === null, 'no input channel without HIVEMIND_ALLOW_DISPATCH');
  assert(detectInputChannel({ TMUX_PANE: '%7' }) === null, 'no input channel even in tmux unless opted in');
  const ch = detectInputChannel({ HIVEMIND_ALLOW_DISPATCH: '1', TMUX_PANE: '%7' });
  assert(ch && ch.type === 'tmux' && ch.ref === '%7', 'tmux channel shape correct');
  const it = detectInputChannel({ HIVEMIND_ALLOW_DISPATCH: 'yes', ITERM_SESSION_ID: 'w0t0p0:648B631A-6705-4C38-A4A5-4BBEE7935D2F' });
  assert(it && it.type === 'iterm' && it.ref === '648B631A-6705-4C38-A4A5-4BBEE7935D2F', 'iterm channel shape correct');

  if (!tmuxAvailable()) {
    console.log('\ntmux not installed — skipping the live injection round-trip.');
    return finish();
  }

  // --- real injection into a tmux pane ---
  const out = path.join(rt, 'sink.txt');
  const sess = `hivedisp_${process.pid}`;
  execSync(`tmux new-session -d -s ${sess} "cat > '${out}'"`);
  await sleep(300);
  const pane = execSync(`tmux list-panes -t ${sess} -F '#{pane_id}'`).toString().trim().split('\n')[0];

  // A dispatchable target (B) advertises that pane; a dispatcher (A) drives it.
  const a = new PersistentClient({ agent: mk('dispatcher'), log: () => {} });
  const b = new PersistentClient({ agent: mk('target', { inputChannel: { type: 'tmux', ref: pane } }), log: () => {} });
  await a.ensureConnected();
  await b.ensureConnected();

  // Routing: target resolves to its channel; self is refused; unknown -> not found.
  const gc = await a.request('get_channel', { to: 'target' });
  assert(gc.found && gc.channel && gc.channel.ref === pane, 'get_channel returns the target\'s channel');
  const gcSelf = await a.request('get_channel', { to: 'dispatcher' });
  assert(gcSelf.found && gcSelf.self === true, 'get_channel flags self');
  const c = new PersistentClient({ agent: mk('plain'), log: () => {} });
  await c.ensureConnected();
  const gcPlain = await a.request('get_channel', { to: 'plain' });
  assert(gcPlain.found && !gcPlain.channel, 'non-dispatchable instance exposes no channel');

  // The actual injection: type a prompt + Enter into the target pane.
  const res = await inject(gc.channel, 'implement the login form', true);
  assert(res.ok && res.via === 'tmux', 'injection reported success');

  let got = '';
  for (let i = 0; i < 12; i++) {
    await sleep(300);
    try { got = fs.readFileSync(out, 'utf8'); } catch (_) {}
    if (got.includes('implement the login form')) break;
  }
  assert(got.includes('implement the login form'), 'injected prompt + Enter actually landed in the target pane');

  try { execSync(`tmux kill-session -t ${sess}`); } catch (_) {}
  await a.unregister();
  await b.unregister();
  await c.unregister();
  finish();
}

function finish() {
  console.log(`\nALL ${passed} DISPATCH CHECKS PASSED`);
  quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
  setTimeout(() => {
    try { fs.rmSync(rt, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
  }, 200);
}

main().catch((e) => {
  console.error('\n' + e.message);
  quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
  setTimeout(() => process.exit(1), 300);
});
