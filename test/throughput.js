'use strict';

// Throughput + latency benchmark for the hub. Proves the coordination fabric is
// fast enough that messaging is never the bottleneck. Runs against an isolated
// socket. Usage: node test/throughput.js [N]

const os = require('os');
const fs = require('fs');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hivebench-'));
process.env.XDG_RUNTIME_DIR = tmp;

const C = require('../src/lib/common');
const { PersistentClient, quickRequest } = require('../src/lib/hub-client');

const N = Number(process.argv[2]) || 20000;
const group = { id: 'g_bench', label: 'bench', dir: '/tmp/bench' };
const mk = (name) => ({ id: C.genId('a'), name, group: group.id, groupLabel: group.label, cwd: group.dir, pid: process.pid, model: '' });

async function main() {
  const a = new PersistentClient({ agent: mk('sender'), log: () => {} });
  const b = new PersistentClient({ agent: mk('receiver'), log: () => {} });
  await a.ensureConnected();
  await b.ensureConnected();

  // Round-trip latency (single in-flight send -> reply), median of 200.
  const lat = [];
  for (let i = 0; i < 200; i++) {
    const t0 = process.hrtime.bigint();
    await a.request('send', { to: 'receiver', body: 'x' });
    lat.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  lat.sort((x, y) => x - y);
  const median = lat[Math.floor(lat.length / 2)];
  const p99 = lat[Math.floor(lat.length * 0.99)];
  await b.request('inbox'); // drain

  // Sustained, lossless throughput: send in pipelined batches kept under the
  // receiver's inbox cap, draining each batch with a real consumer — so nothing
  // is dropped and the number reflects honest end-to-end delivery.
  const BATCH = 4000; // < MAX_INBOX (5000)
  let sent = 0;
  let drained = 0;
  const start = process.hrtime.bigint();
  while (sent < N) {
    const n = Math.min(BATCH, N - sent);
    const promises = new Array(n);
    for (let i = 0; i < n; i++) promises[i] = a.request('send', { to: 'receiver', body: sent + i }, 30000);
    await Promise.all(promises);
    sent += n;
    for (;;) {
      const r = await b.request('inbox');
      if (!r.messages.length) break;
      drained += r.messages.length;
    }
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  const perSec = Math.round((N / elapsedMs) * 1000);

  console.log(`Messages:        ${N} (in batches of ${BATCH}, drained by a live consumer)`);
  console.log(`End-to-end time: ${elapsedMs.toFixed(1)} ms`);
  console.log(`Throughput:      ${perSec.toLocaleString()} msgs/sec (sustained, lossless)`);
  console.log(`RTT latency:     median ${median.toFixed(3)} ms, p99 ${p99.toFixed(3)} ms`);
  console.log(`Delivered:       ${drained}/${N} ${drained === N ? '(all accounted for)' : '(MISMATCH)'}`);

  await a.unregister();
  await b.unregister();
  await quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});

  if (drained !== N) {
    throw new Error('message loss under load');
  }
}

main()
  .then(() => {
    setTimeout(() => {
      try {
        fs.rmSync(tmp, { recursive: true, force: true });
      } catch (_) {}
      process.exit(0);
    }, 150);
  })
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
