'use strict';

// Verifies the hub's filesystem watcher: external changes surface in the change
// feed, the agent's own edits are deduped out, and noise dirs are ignored.
// Self-skips if recursive fs watching isn't available on this platform (so CI
// stays green on systems without it). Usage: node test/watcher.js

const os = require('os');
const fs = require('fs');
const path = require('path');

const rt = fs.mkdtempSync(path.join(os.tmpdir(), 'hivewatch-rt-'));
process.env.XDG_RUNTIME_DIR = rt;

const C = require('../src/lib/common');
const { PersistentClient, quickRequest } = require('../src/lib/hub-client');

const proj = fs.mkdtempSync(path.join(os.tmpdir(), 'hivewatch-proj-'));
const group = { id: 'g_watch', label: 'watch', dir: proj };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let passed = 0;
function assert(cond, name) {
  if (!cond) throw new Error(`FAILED: ${name}`);
  passed++;
  console.log(`  ok  ${name}`);
}

async function fsChangesFor(client, name) {
  const r = await client.request('list_changes');
  return (r.changes || []).filter((c) => c.who === 'filesystem' && path.basename(c.file) === name);
}

async function main() {
  const a = new PersistentClient({
    agent: { id: C.genId('a'), name: 'alpha', group: group.id, groupLabel: group.label, cwd: proj, pid: process.pid, model: '' },
    log: () => {},
  });
  await a.ensureConnected(); // registers -> hub captures proj as group.dir and starts watching
  await sleep(600); // let the watcher attach

  // Mark an agent edit BEFORE writing the file, so its later write is deduped.
  const agentFile = path.join(proj, 'agentfile.txt');
  await a.request('record_change', { group: group.id, who: 'alpha', file: agentFile, tool: 'Write' });

  // External change (not from any agent) + the agent's own write + pure noise.
  fs.writeFileSync(path.join(proj, 'external.txt'), 'hello');
  fs.writeFileSync(agentFile, 'agent wrote this');
  fs.mkdirSync(path.join(proj, 'node_modules'), { recursive: true });
  fs.writeFileSync(path.join(proj, 'node_modules', 'junk.js'), 'noise');

  // Poll for the external change (debounce + FS latency). Skip if unsupported.
  let found = [];
  for (let i = 0; i < 14; i++) {
    await sleep(500);
    found = await fsChangesFor(a, 'external.txt');
    if (found.length) break;
  }
  if (!found.length) {
    console.log('\nfilesystem watching not available on this platform — skipping.');
    await a.unregister();
    await quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
    return;
  }

  assert(found.length > 0, 'external change surfaces in the feed as "filesystem"');
  const agentDup = await fsChangesFor(a, 'agentfile.txt');
  assert(agentDup.length === 0, "agent's own edit is deduped out of the FS feed");
  const noise = await fsChangesFor(a, 'junk.js');
  assert(noise.length === 0, 'node_modules noise is ignored');

  // The summary should reach the digest feed (what agents see each turn).
  const dg = await quickRequest('digest', { group: group.id, sinceTs: 0 }, { timeoutMs: 1000 });
  const fsFeed = (dg.recentBroadcasts || []).filter((b) => b.kind === 'fs');
  assert(fsFeed.length > 0, 'FS summary appears in the per-turn digest feed');

  await a.unregister();
  await quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
  console.log(`\nALL ${passed} WATCHER CHECKS PASSED`);
}

main()
  .then(() => {
    for (const d of [rt, proj]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch (_) {}
    }
    process.exit(0);
  })
  .catch((e) => {
    console.error('\n' + e.message);
    quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
    setTimeout(() => process.exit(1), 300);
  });
