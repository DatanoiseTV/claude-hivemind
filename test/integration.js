'use strict';

// End-to-end exercise of the hub via two simulated agents. Runs against an
// isolated socket (private XDG_RUNTIME_DIR) so it never touches a real hive.
// Usage: node test/integration.js

const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hivetest-'));
process.env.XDG_RUNTIME_DIR = tmp;

const C = require('../src/lib/common');
const { PersistentClient, quickRequest } = require('../src/lib/hub-client');

let passed = 0;
function assert(cond, name) {
  if (!cond) throw new Error(`FAILED: ${name}`);
  passed++;
  console.log(`  ok  ${name}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const group = { id: 'g_test', label: 'testproj', dir: '/tmp/testproj' };
function mkAgent(name) {
  return { id: C.genId('a'), name, group: group.id, groupLabel: group.label, cwd: group.dir, pid: process.pid, model: '' };
}

async function main() {
  const a = new PersistentClient({ agent: mkAgent('alpha'), log: () => {} });
  const b = new PersistentClient({ agent: mkAgent('beta'), log: () => {} });
  await a.ensureConnected();
  await b.ensureConnected();
  assert(true, 'two agents connected & registered (hub autostarted)');

  let r = await a.request('peers');
  assert(r.peers.length === 1 && r.peers[0].name === 'beta', 'peers lists the other agent, not self');

  await a.request('send', { to: 'beta', body: 'hello' });
  r = await b.request('inbox');
  assert(r.messages.some((m) => m.body === 'hello'), 'direct message delivered to inbox');

  await b.request('broadcast', { body: 'hi all' });
  r = await a.request('inbox');
  assert(r.messages.some((m) => m.body === 'hi all'), 'broadcast reaches peer inbox');

  await a.request('share', { key: 'k1', value: 'v1', summary: 's' });
  r = await b.request('recall', { key: 'k1' });
  assert(r.found && r.value === 'v1', 'shared context recall returns value');

  r = await a.request('task_post', { title: 'T1' });
  const tid = r.task.id;
  r = await b.request('task_claim', { task_id: tid });
  assert(r.task.claimedBy === 'beta', 'task claimed by beta');

  let threw = false;
  try {
    await a.request('task_claim', { task_id: tid });
  } catch (_) {
    threw = true;
  }
  assert(threw, 'second claim of same task is rejected (atomic)');

  await b.request('task_update', { task_id: tid, status: 'done', note: 'ok' });
  r = await a.request('task_list');
  assert(r.tasks.find((t) => t.id === tid).status === 'done', 'task marked done');

  r = await a.request('lock', { resource: 'file.js' });
  assert(r.acquired, 'lock acquired by alpha');
  r = await b.request('lock', { resource: 'file.js' });
  assert(!r.acquired && r.holder === 'alpha', 'conflicting lock reports holder');
  await a.request('unlock', { resource: 'file.js' });
  r = await b.request('lock', { resource: 'file.js' });
  assert(r.acquired, 'lock acquirable after release');

  r = await a.request('elect', { role: 'leader' });
  assert(r.leader, 'alpha wins leader election');
  r = await b.request('elect', { role: 'leader' });
  assert(!r.leader && r.holder === 'alpha', 'beta defers to existing leader');

  // Real-time: beta blocks on wait, alpha sends; wait must wake.
  const waitP = b.request('wait', { want: ['message'], timeout_ms: 3000 }, 6000);
  setTimeout(() => a.request('send', { to: 'beta', body: 'ping' }).catch(() => {}), 200);
  r = await waitP;
  assert(r.messages && r.messages.some((m) => m.body === 'ping'), 'wait long-poll wakes on incoming message');

  // Barrier: both arrive, both release together.
  const [br1, br2] = await Promise.all([
    a.request('barrier', { name: 'phase1', parties: 2, timeout_ms: 3000 }, 6000),
    b.request('barrier', { name: 'phase1', parties: 2, timeout_ms: 3000 }, 6000),
  ]);
  assert(br1.released && br2.released, 'barrier releases when all parties arrive');

  await quickRequest('record_change', { group: group.id, who: 'sess1', file: 'x.js', tool: 'Edit' }, { timeoutMs: 1000 });
  r = await a.request('list_changes');
  assert(r.changes.some((c) => c.file === 'x.js'), 'recorded change appears in feed');

  r = await a.request('status', { group: group.id });
  assert(r.groups[0] && r.groups[0].agents.length === 2, 'status snapshot shows both instances');
  assert(typeof r.hub.startedAt === 'number', 'status includes hub meta for the dashboard');

  // Disconnect beta -> presence + held lock must be reaped by the hub.
  await b.unregister();
  await sleep(300);
  r = await a.request('peers');
  assert(r.peers.length === 0, 'peer reaped after disconnect');
  r = await a.request('status', { group: group.id });
  assert((r.groups[0].locks || []).length === 0, 'disconnected agent\'s lock released');

  await a.unregister();
  await quickRequest('shutdown', {}, { timeoutMs: 500 });
  await sleep(150);
  console.log(`\nALL ${passed} CHECKS PASSED`);
}

main()
  .then(() => {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch (_) {}
    process.exit(0);
  })
  .catch((e) => {
    console.error('\n' + e.message);
    try {
      quickRequest('shutdown', {}, { timeoutMs: 500 });
    } catch (_) {}
    setTimeout(() => process.exit(1), 300);
  });
