#!/usr/bin/env node
'use strict';

// Human CLI for inspecting the hive hub. Not used by Claude — a debugging and
// observability tool for you.
//
//   node src/cli.js status        one-shot snapshot of all hives
//   node src/cli.js watch         live-updating dashboard (Ctrl-C to exit)
//   node src/cli.js groups        list active project hives
//   node src/cli.js stop          ask the hub to shut down
//   node src/cli.js where         print socket + log paths

const C = require('./lib/common');
const { quickRequest } = require('./lib/hub-client');

function age(ts) {
  const s = Math.max(0, Math.round((C.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  return `${Math.round(s / 3600)}h`;
}

function renderSnapshot(snap) {
  const out = [];
  out.push(`\x1b[1m● ${snap.group.label}\x1b[0m  (group ${snap.group.id})  — ${snap.agents.length} instance(s)`);
  for (const a of snap.agents) {
    out.push(`    ${a.name}  ${a.status === 'active' ? '' : `[${a.status}] `}${a.cwd}  (seen ${age(a.lastSeen)} ago)`);
  }
  const tasks = snap.tasks || [];
  if (tasks.length) {
    out.push('  tasks:');
    for (const t of tasks) {
      out.push(`    [${t.id}] ${t.status}${t.claimedBy ? ` @${t.claimedBy}` : ''}: ${t.title}`);
    }
  }
  if (snap.notes && snap.notes.length) {
    out.push('  shared context: ' + snap.notes.map((n) => n.key).join(', '));
  }
  if (snap.locks && snap.locks.length) {
    out.push('  locks: ' + snap.locks.map((l) => `${l.resource}@${l.holder}`).join(', '));
  }
  return out.join('\n');
}

async function getGroups() {
  const r = await quickRequest('status', {}, { timeoutMs: 1500 });
  if (!r) return null;
  return r.groups || [];
}

async function cmdStatus() {
  const groups = await getGroups();
  if (groups === null) {
    console.log('Hive hub is not running.');
    return;
  }
  if (!groups.length) {
    console.log('Hub is running; no active hives.');
    return;
  }
  console.log(groups.map(renderSnapshot).join('\n\n'));
}

async function cmdWatch() {
  const tick = async () => {
    const groups = await getGroups();
    process.stdout.write('\x1b[2J\x1b[H');
    const header = `Hivemind — ${new Date().toLocaleTimeString()}   (Ctrl-C to exit)\n`;
    if (groups === null) {
      process.stdout.write(header + '\nHub is not running.\n');
    } else if (!groups.length) {
      process.stdout.write(header + '\nNo active hives.\n');
    } else {
      process.stdout.write(header + '\n' + groups.map(renderSnapshot).join('\n\n') + '\n');
    }
  };
  await tick();
  const iv = setInterval(tick, 2000);
  process.on('SIGINT', () => {
    clearInterval(iv);
    process.stdout.write('\n');
    process.exit(0);
  });
}

async function cmdGroups() {
  const groups = await getGroups();
  if (groups === null) return console.log('Hive hub is not running.');
  if (!groups.length) return console.log('No active hives.');
  for (const g of groups) console.log(`${g.group.id}  ${g.group.label}  (${g.agents.length})`);
}

async function cmdStop() {
  const r = await quickRequest('shutdown', {}, { timeoutMs: 1500 });
  console.log(r ? 'Shutdown signal sent.' : 'Hub was not running.');
}

function cmdWhere() {
  console.log(`socket: ${C.socketPath()}`);
  console.log(`log:    ${C.hubLogPath()}`);
  console.log(`state:  ${C.stateDir()}`);
}

const cmd = process.argv[2] || 'status';
const table = {
  status: cmdStatus,
  watch: cmdWatch,
  groups: cmdGroups,
  stop: cmdStop,
  where: cmdWhere,
};
(table[cmd] || (() => console.log('usage: cli.js [status|watch|groups|stop|where]')))();
