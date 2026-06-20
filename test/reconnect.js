'use strict';

// Proves an idle persistent client (an instance whose agent isn't actively
// calling hive tools) rejoins the hive on its own after the hub restarts — its
// presence is restored without any explicit request. Regression test for the
// orphaned-on-restart bug. Usage: node test/reconnect.js

const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hivereconn-'));
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
const group = { id: 'g_reconn', label: 'reconn', dir: '/tmp/reconn' };
const mk = (name) => ({ id: C.genId('a'), name, group: group.id, groupLabel: group.label, cwd: group.dir, pid: process.pid, model: '' });

async function presentNames() {
  const r = await quickRequest('status', { group: group.id }, { timeoutMs: 1500 });
  if (!r || !r.groups || !r.groups[0]) return [];
  return r.groups[0].agents.map((a) => a.name);
}

async function main() {
  // An idle instance: connects once, then never calls a hive tool again.
  const a = new PersistentClient({ agent: mk('idle-instance'), heartbeatMs: 600, log: () => {} });
  await a.ensureConnected();
  assert((await presentNames()).includes('idle-instance'), 'instance present after first connect');

  // Hub dies (a restart / crash).
  await quickRequest('shutdown', {}, { timeoutMs: 500 });
  await sleep(400);

  // The client is given NO explicit request. It must rejoin on its own.
  let names = [];
  for (let i = 0; i < 12; i++) {
    await sleep(500);
    names = await presentNames();
    if (names.includes('idle-instance')) break;
  }
  assert(names.includes('idle-instance'), 'idle instance auto-rejoined the hive after a hub restart');

  await a.unregister();
  await quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
  await sleep(150);
  console.log(`\nALL ${passed} RECONNECT CHECKS PASSED`);
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
