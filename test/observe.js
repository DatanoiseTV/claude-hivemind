'use strict';

// Verifies the `observe` consolidated-awareness op: one call returns the delta
// since a cursor (new messages, task/file/context changes, ready work, peers),
// drains messages, and never re-shows changes older than the cursor.
// Usage: node test/observe.js

const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hiveobs-'));
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
const group = { id: 'g_obs', label: 'obs', dir: '/tmp/obs' };
const mk = (name) => ({ id: C.genId('a'), name, group: group.id, groupLabel: group.label, cwd: group.dir, pid: process.pid, model: '' });

async function main() {
  const a = new PersistentClient({ agent: mk('observer'), log: () => {} });
  const b = new PersistentClient({ agent: mk('peer'), log: () => {} });
  await a.ensureConnected();
  await b.ensureConnected();

  await b.request('send', { to: 'observer', body: 'hello A' });
  await b.request('task_post', { title: 'do X' });
  await b.request('share', { key: 'plan', value: 'the plan', summary: 'p' });
  await quickRequest('record_change', { group: group.id, who: 'ext', file: '/p/f.js', tool: 'fs' }, { timeoutMs: 1000 });

  const r = await a.request('observe', { sinceTs: 0 });
  assert(r.messages.some((m) => m.body === 'hello A'), 'observe returns new messages');
  assert(r.taskChanges.some((t) => t.title === 'do X'), 'observe returns task changes');
  assert(r.readyTasks.some((t) => t.title === 'do X'), 'observe returns what is ready to claim');
  assert(r.fileChanges.some((c) => c.file.endsWith('f.js')), 'observe returns file changes');
  assert(r.contextChanges.some((n) => n.key === 'plan'), 'observe returns shared-context changes');
  assert(r.peers.some((p) => p.name === 'peer'), 'observe returns active peers');
  const cursor = r.nowTs;

  const r2 = await a.request('observe', { sinceTs: cursor });
  assert(
    r2.messages.length === 0 && r2.taskChanges.length === 0 && r2.fileChanges.length === 0 && r2.contextChanges.length === 0,
    'observe with the cursor shows nothing stale'
  );

  await sleep(5); // ensure the next change lands in a later ms than the cursor
  await b.request('share', { key: 'k2', value: 'v2' });
  const r3 = await a.request('observe', { sinceTs: cursor });
  assert(r3.contextChanges.some((n) => n.key === 'k2'), 'observe shows the new change after the cursor');
  assert(!r3.contextChanges.some((n) => n.key === 'plan'), 'observe does not re-show changes older than the cursor');

  await a.unregister();
  await b.unregister();
  await quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
  console.log(`\nALL ${passed} OBSERVE CHECKS PASSED`);
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
