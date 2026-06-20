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

  // Dependency-gated task board.
  const tA = (await a.request('task_post', { title: 'design', priority: 5 })).task;
  const tB = (await a.request('task_post', { title: 'build', deps: [tA.id] })).task;
  assert(tA.ready === true, 'task with no deps is ready');
  assert(tB.ready === false && tB.blockedBy.includes(tA.id), 'task with unmet dep is blocked');
  let blocked = false;
  try {
    await b.request('task_claim', { task_id: tB.id });
  } catch (_) {
    blocked = true;
  }
  assert(blocked, 'claiming a blocked task is rejected');

  // task_next picks the best READY task (design), not the blocked one.
  const next = await b.request('task_next');
  assert(next.task && next.task.id === tA.id, 'task_next claims the ready, highest-priority task');

  // Completing the dependency unblocks the dependent task.
  await b.request('task_update', { task_id: tA.id, status: 'done' });
  const list = (await a.request('task_list')).tasks;
  const buildNow = list.find((t) => t.id === tB.id);
  assert(buildNow.ready === true, 'dependent task becomes ready once its dep is done');

  // Auto-presence: claiming set beta's current task; finishing cleared it.
  const peersAfter = (await a.request('peers')).peers;
  const beta = peersAfter.find((p) => p.name === 'beta');
  assert(beta && beta.currentTask === null, 'auto-presence cleared after task completion');

  // Capability routing: tagged task goes to the capable instance first.
  await a.request('task_post', { title: 'rust work', tags: ['rust'] });
  await a.request('task_post', { title: 'ui work', tags: ['frontend'] });
  // beta registered without caps; give a fresh capable agent.
  const ccap = new PersistentClient({ agent: { ...mkAgent('gamma'), capabilities: ['rust'] }, log: () => {} });
  await ccap.ensureConnected();
  const gnext = await ccap.request('task_next');
  assert(gnext.task && gnext.task.title === 'rust work', 'capability-matched task routed to capable instance');
  await ccap.unregister();

  // Cross-IDE identity: a different environment/model surfaces on presence.
  const oc = new PersistentClient({ agent: { ...mkAgent('delta'), client: 'opencode', model: 'gpt-5' }, log: () => {} });
  await oc.ensureConnected();
  const dp = (await a.request('peers')).peers.find((p) => p.name === 'delta');
  assert(dp && dp.client === 'opencode' && dp.model === 'gpt-5', 'client/model surface on presence (mixed-IDE fleet)');
  await oc.unregister();

  // A non-MCP one-shot participant (a script/other tool) names its actions via `as`.
  await quickRequest('task_post', { group: group.id, as: 'cli:bob', title: 'from a script' }, { timeoutMs: 1000 });
  const scriptTask = (await a.request('task_list')).tasks.find((t) => t.title === 'from a script');
  assert(scriptTask && scriptTask.by === 'cli:bob', 'one-shot CLI participant labels its actions with as');

  // No auto-dispatch: a peer joining/leaving must NOT wake an instance that is
  // waiting for messages. Only an explicit peer send does.
  await b.request('inbox'); // clear any pending first
  const waitNoWake = b.request('wait', { want: ['message'], timeout_ms: 700 }, 3000);
  const tmp = new PersistentClient({ agent: mkAgent('epsilon'), log: () => {} });
  await tmp.ensureConnected(); // a join — passive, must not wake b
  const wr = await waitNoWake;
  assert(wr.timeout === true, 'a peer joining does not wake a waiting instance (no auto-dispatch)');
  await tmp.unregister();

  // Turn-activity pulse increments the dashboard turns counter.
  const beforeTurns = (await a.request('status', { group: group.id })).groups[0].stats.turns;
  await quickRequest('note_activity', { group: group.id, kind: 'turn', sessionKey: 'sx', label: 'doing things' }, { timeoutMs: 1000 });
  const afterTurns = (await a.request('status', { group: group.id })).groups[0].stats.turns;
  assert(afterTurns === beforeTurns + 1, 'note_activity bumps the turns counter');

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
