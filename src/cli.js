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

// --- Coordination ops for non-MCP environments / scripts -------------------
// These derive the hive from the current directory and act one-shot, so any
// tool (a shell script, a CI step, an agent in an IDE without MCP) can join the
// task board, messaging, and shared context. `as` gives the actor a name.

const os = require('os');
function ctx() {
  const g = C.groupFor(process.cwd());
  const as = process.env.HIVEMIND_NAME || `cli:${os.userInfo().username}`;
  return { group: g.id, groupLabel: g.label, as };
}
function caps() {
  return (process.env.HIVEMIND_CAPS || '').split(',').map((s) => s.trim()).filter(Boolean);
}
const rest = (from) => process.argv.slice(from).join(' ');
const offline = () => console.log('Hive hub is not running (start a Claude Code / MCP instance in this project first).');

async function cmdPeers() {
  const c = ctx();
  const r = await quickRequest('status', { group: c.group }, { timeoutMs: 1500 });
  if (!r) return offline();
  const snap = (r.groups || [])[0];
  if (!snap || !snap.agents.length) return console.log('No instances in this hive.');
  for (const a of snap.agents) {
    const env = [a.client, a.model].filter(Boolean).join('/');
    console.log(`${a.name}${env ? `  (${env})` : ''}${a.currentTask ? `  ▶ ${a.currentTask}` : ''}`);
  }
}

async function cmdTasks() {
  const c = ctx();
  const r = await quickRequest('task_list', { group: c.group, groupLabel: c.groupLabel }, { timeoutMs: 1500 });
  if (!r || !r.ok) return offline();
  if (!r.tasks.length) return console.log('Task board empty.');
  for (const t of r.tasks) {
    let state = t.status.toUpperCase();
    if (t.status === 'open') state = t.ready ? 'READY' : `BLOCKED(${(t.blockedBy || []).join(',')})`;
    console.log(`[${t.id}] ${state}${t.claimedBy ? ` @${t.claimedBy}` : ''}: ${t.title}`);
  }
}

async function cmdTaskNext() {
  const c = ctx();
  const r = await quickRequest('task_next', { group: c.group, groupLabel: c.groupLabel, as: c.as, capabilities: caps() }, { timeoutMs: 1500 });
  if (!r || !r.ok) return offline();
  console.log(r.task ? `Claimed ${r.task.id}: ${r.task.title}` : 'No ready task available.');
}

async function cmdTaskPost() {
  const title = rest(3);
  if (!title) return console.log('usage: hivemind task-post <title>');
  const c = ctx();
  const r = await quickRequest('task_post', { group: c.group, groupLabel: c.groupLabel, as: c.as, title }, { timeoutMs: 1500 });
  if (!r || !r.ok) return offline();
  console.log(`Posted ${r.task.id}: ${r.task.title}`);
}

async function cmdTaskDone() {
  const id = process.argv[3];
  if (!id) return console.log('usage: hivemind task-done <id> [note]');
  const c = ctx();
  const r = await quickRequest('task_update', { group: c.group, groupLabel: c.groupLabel, as: c.as, task_id: id, status: 'done', note: rest(4) }, { timeoutMs: 1500 });
  if (!r || !r.ok) return offline();
  console.log(`Task ${id} -> done.`);
}

async function cmdInbox() {
  const c = ctx();
  const r = await quickRequest('inbox', { group: c.group, groupLabel: c.groupLabel, as: c.as }, { timeoutMs: 1500 });
  if (!r || !r.ok) return offline();
  if (!r.messages.length) return console.log(`No messages for "${c.as}".`);
  for (const m of r.messages) console.log(`${m.fromName}: ${m.body}`);
}

async function cmdSend() {
  const to = process.argv[3];
  const body = rest(4);
  if (!to || !body) return console.log('usage: hivemind send <peer> <message>');
  const c = ctx();
  const r = await quickRequest('send', { group: c.group, groupLabel: c.groupLabel, as: c.as, to, body }, { timeoutMs: 1500 });
  if (!r) return offline();
  console.log(r.ok ? `Sent to ${r.to}.` : `Error: ${r.error}`);
}

async function cmdBroadcast() {
  const body = rest(3);
  if (!body) return console.log('usage: hivemind broadcast <message>');
  const c = ctx();
  const r = await quickRequest('broadcast', { group: c.group, groupLabel: c.groupLabel, as: c.as, body }, { timeoutMs: 1500 });
  if (!r || !r.ok) return offline();
  console.log(`Broadcast to ${r.delivered} peer(s).`);
}

async function cmdShare() {
  const key = process.argv[3];
  const value = rest(4);
  if (!key || !value) return console.log('usage: hivemind share <key> <value>');
  const c = ctx();
  const r = await quickRequest('share', { group: c.group, groupLabel: c.groupLabel, as: c.as, key, value }, { timeoutMs: 1500 });
  if (!r || !r.ok) return offline();
  console.log(`Shared "${key}".`);
}

async function cmdRecall() {
  const key = process.argv[3];
  const c = ctx();
  if (key) {
    const r = await quickRequest('recall', { group: c.group, groupLabel: c.groupLabel, key }, { timeoutMs: 1500 });
    if (!r || !r.ok) return offline();
    return console.log(r.found ? r.value : `No shared context for "${key}".`);
  }
  const r = await quickRequest('list_notes', { group: c.group, groupLabel: c.groupLabel }, { timeoutMs: 1500 });
  if (!r || !r.ok) return offline();
  if (!r.notes.length) return console.log('No shared context.');
  for (const n of r.notes) console.log(`${n.key}${n.summary ? `  — ${n.summary}` : ''}`);
}

async function cmdChanges() {
  const c = ctx();
  const r = await quickRequest('list_changes', { group: c.group, groupLabel: c.groupLabel }, { timeoutMs: 1500 });
  if (!r || !r.ok) return offline();
  if (!r.changes.length) return console.log('No recent edits.');
  for (const ch of r.changes.slice(-20)) console.log(`${ch.who}  ${ch.tool}  ${ch.file}`);
}

const cmd = process.argv[2] || 'status';
const table = {
  status: cmdStatus,
  watch: cmdWatch,
  groups: cmdGroups,
  stop: cmdStop,
  where: cmdWhere,
  peers: cmdPeers,
  tasks: cmdTasks,
  'task-next': cmdTaskNext,
  'task-post': cmdTaskPost,
  'task-done': cmdTaskDone,
  inbox: cmdInbox,
  send: cmdSend,
  broadcast: cmdBroadcast,
  share: cmdShare,
  recall: cmdRecall,
  changes: cmdChanges,
};
const usage =
  'usage: hivemind <command>\n' +
  '  monitor                 full-screen dashboard (ratatui)\n' +
  '  status | watch          snapshot / live view of all hives\n' +
  '  groups | where | stop   list hives / paths / stop the hub\n' +
  '  peers                   instances in this project hive\n' +
  '  tasks                   the shared task board\n' +
  '  task-next               claim the best ready task (for scripts)\n' +
  '  task-post <title>       add a task\n' +
  '  task-done <id> [note]   mark a task done\n' +
  '  send <peer> <msg>       direct message a peer or named participant\n' +
  '  inbox                   read messages for HIVEMIND_NAME (a subagent mailbox)\n' +
  '  broadcast <msg>         message the whole hive\n' +
  '  share <key> <value>     publish shared context\n' +
  '  recall [key]            read shared context\n' +
  '  changes                 recent file edits in the hive';
(table[cmd] || (() => console.log(usage)))();
