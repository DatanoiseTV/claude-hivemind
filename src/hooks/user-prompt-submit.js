'use strict';

// UserPromptSubmit hook: at the start of each turn, fold any fresh hive activity
// (new broadcasts, shared context, task-board movement) into the model's
// context, so an instance "hears" its peers in near real time even when it
// isn't actively polling. Uses a per-session cursor so it only surfaces what's
// new since the previous turn, and stays silent when nothing changed or the
// instance is working solo.

const fs = require('fs');
const C = require('../lib/common');
const { quickRequest } = require('../lib/hub-client');
const { readStdinJson, emitContext } = require('../lib/hook-util');

function readCursor(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')).ts || 0;
  } catch (_) {
    return 0;
  }
}

function writeCursor(file, ts) {
  try {
    fs.writeFileSync(file, JSON.stringify({ ts }));
  } catch (_) {
    /* ignore */
  }
}

// Opportunistically drop cursor files for sessions that ended long ago.
function pruneOldCursors() {
  try {
    const dir = C.stateDir();
    const cutoff = C.now() - 24 * 60 * 60 * 1000;
    for (const f of fs.readdirSync(dir)) {
      if (!f.startsWith('cursor-')) continue;
      const p = `${dir}/${f}`;
      try {
        if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p);
      } catch (_) {
        /* ignore */
      }
    }
  } catch (_) {
    /* ignore */
  }
}

(async () => {
  const evt = await readStdinJson();
  const group = C.groupFor(evt.cwd);
  const cursorFile = C.cursorPath(evt.session_id);
  const sinceTs = readCursor(cursorFile);

  const r = await quickRequest('digest', { group: group.id, sinceTs }, { timeoutMs: 1000 });
  if (!r || !r.ok) process.exit(0);

  writeCursor(cursorFile, r.nowTs || C.now());
  if (Math.random() < 0.05) pruneOldCursors();

  const peers = (r.peers || []).filter(Boolean);
  // Solo instance with nothing happening: stay quiet.
  if (peers.length <= 1 && !(r.recentBroadcasts || []).length && !r.openTasks) {
    process.exit(0);
  }

  const lines = [];
  const others = peers.length - 1;
  if (others > 0) lines.push(`${others} peer instance(s) active in this hive.`);
  if (r.openTasks || r.claimedTasks) {
    lines.push(`Task board: ${r.openTasks || 0} open, ${r.claimedTasks || 0} in progress.`);
  }
  const bc = (r.recentBroadcasts || []).filter((b) => b.fromName);
  if (bc.length) {
    lines.push('New hive activity since your last turn:');
    for (const b of bc) lines.push(`  - ${b.fromName}: ${b.body}`);
  }
  if (!lines.length) process.exit(0);

  emitContext(
    'UserPromptSubmit',
    `[HIVEMIND] ${lines.join('\n')}\n(Use the hive inbox/wait/recall/task tools to engage if relevant.)`
  );
})().catch(() => process.exit(0));
