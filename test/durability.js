'use strict';

// Durability test: the task board and shared context must survive a full hub
// restart, and in-flight (claimed) work must reopen so a fresh fleet resumes it.
// Runs against an isolated socket. Usage: node test/durability.js

const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hivedura-'));
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
const group = { id: 'g_dura', label: 'dura', dir: '/tmp/dura' };
const mk = (name) => ({ id: C.genId('a'), name, group: group.id, groupLabel: group.label, cwd: group.dir, pid: process.pid, model: '' });

async function main() {
  // Round 1: post tasks, share context, claim one (leave it in-flight).
  let a = new PersistentClient({ agent: mk('alpha'), log: () => {} });
  await a.ensureConnected();
  const t1 = (await a.request('task_post', { title: 'persisted task', priority: 3 })).task;
  await a.request('task_post', { title: 'second task', deps: [t1.id] });
  await a.request('share', { key: 'plan', value: 'the durable plan', summary: 'plan' });
  await a.request('task_claim', { task_id: t1.id }); // in-flight
  await sleep(2000); // allow debounced persist (1.5s) to flush
  await a.unregister();

  // Hard restart: shut the hub down entirely.
  await quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
  await sleep(400);

  // Round 2: a fresh agent reconnects -> hub autostarts -> state rehydrates.
  let b = new PersistentClient({ agent: mk('beta'), log: () => {} });
  await b.ensureConnected();
  const tasks = (await b.request('task_list')).tasks;
  assert(tasks.find((t) => t.title === 'persisted task'), 'task board survived hub restart');
  assert(tasks.find((t) => t.title === 'second task'), 'all posted tasks survived');
  const reopened = tasks.find((t) => t.title === 'persisted task');
  assert(reopened.status === 'open' && !reopened.claimedBy, 'in-flight task reopened after restart');
  const recalled = await b.request('recall', { key: 'plan' });
  assert(recalled.found && recalled.value === 'the durable plan', 'shared context survived hub restart');

  await b.unregister();
  await quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
  await sleep(150);
  console.log(`\nALL ${passed} DURABILITY CHECKS PASSED`);
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
    process.exit(1);
  });
