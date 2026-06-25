'use strict';

// Verifies the task-board auto-fill: an instance's native task list is mirrored
// onto the hive board (create/update/list-snapshot), mirrored tasks show but are
// never claimable, manual tasks stay claimable alongside them, and SessionEnd
// clears them. Usage: node test/mirror.js

const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemirror-'));
process.env.XDG_RUNTIME_DIR = tmp;

const C = require('../src/lib/common');
const { PersistentClient, quickRequest } = require('../src/lib/hub-client');

let passed = 0;
function assert(cond, name) {
  if (!cond) throw new Error(`FAILED: ${name}`);
  passed++;
  console.log(`  ok  ${name}`);
}
const group = { id: 'g_mirror', label: 'mirror', dir: '/tmp/mirror' };
const mk = (name) => ({ id: C.genId('a'), name, group: group.id, groupLabel: group.label, cwd: group.dir, pid: process.pid, model: '' });
const mirror = (p) => quickRequest('mirror_tasks', { group: group.id, groupLabel: group.label, sessionKey: 'sess1', who: 'sess1', ...p }, { timeoutMs: 1000 });

async function main() {
  const a = new PersistentClient({ agent: mk('viewer'), log: () => {} });
  await a.ensureConnected();
  const tasks = async () => (await a.request('task_list')).tasks;

  await mirror({ kind: 'create', item: { nativeId: 't-1', subject: 'plan the api', status: 'pending' } });
  let m1 = (await tasks()).find((t) => t.title === 'plan the api');
  assert(m1 && m1.mirrored && m1.owner === 'sess1' && m1.status === 'open', 'native task is mirrored onto the board');

  const nx1 = await a.request('task_next');
  assert(!nx1.task, 'a mirrored task is not claimable by others (task_next)');

  await mirror({ kind: 'update', item: { nativeId: 't-1', status: 'in_progress' } });
  assert((await tasks()).find((t) => t.title === 'plan the api').status === 'in_progress', 'mirrored task status updates');

  await mirror({ kind: 'create', item: { nativeId: 't-2', subject: 'write tests', status: 'pending' } });
  assert((await tasks()).filter((t) => t.mirrored).length === 2, 'a second mirrored task appears');

  // Full-list snapshot: t-1 completed, t-2 no longer present -> removed.
  await mirror({ kind: 'list', items: [{ nativeId: 't-1', subject: 'plan the api', status: 'completed' }] });
  const after = await tasks();
  assert(after.find((t) => t.title === 'plan the api').status === 'done', 'list snapshot marks t-1 done');
  assert(!after.find((t) => t.title === 'write tests'), 'list snapshot removes a task no longer in the list');

  // Manual work-stealing still functions alongside mirrored tasks.
  await a.request('task_post', { title: 'real work' });
  const nx2 = await a.request('task_next');
  assert(nx2.task && nx2.task.title === 'real work', 'manual tasks remain claimable alongside mirrored ones');

  await quickRequest('mirror_clear', { group: group.id, sessionKey: 'sess1' }, { timeoutMs: 1000 });
  assert((await tasks()).filter((t) => t.mirrored).length === 0, 'mirror_clear removes the session\'s mirrored tasks');

  await a.unregister();
  await quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
  console.log(`\nALL ${passed} MIRROR CHECKS PASSED`);
}

main()
  .then(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
    process.exit(0);
  })
  .catch((e) => {
    console.error('\n' + e.message);
    quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
    setTimeout(() => process.exit(1), 300);
  });
