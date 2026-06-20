'use strict';

// SessionStart hook: orient this instance as a member of the project hive and,
// if peers are already present, drop their roster + current task board into the
// session as context so the agent starts collaboration-aware.
//
// Best-effort: if the hub isn't up yet (this may be the first instance), we
// still emit a short orientation so the agent knows the hive tools exist.

const C = require('../lib/common');
const { quickRequest } = require('../lib/hub-client');
const { readStdinJson, emitContext } = require('../lib/hook-util');

(async () => {
  const evt = await readStdinJson();
  const group = C.groupFor(evt.cwd);

  let live = '';
  const r = await quickRequest('digest', { group: group.id }, { timeoutMs: 1200 });
  if (r && r.ok) {
    const peers = (r.peers || []).filter(Boolean);
    if (peers.length > 1 || r.openTasks || r.claimedTasks) {
      const roster = peers.map((p) => `  - ${p.name}${p.status && p.status !== 'active' ? ` [${p.status}]` : ''}`).join('\n');
      live =
        `\n\nThe hive for "${group.label}" is already active:\n` +
        `${peers.length} instance(s) connected${roster ? `:\n${roster}` : ''}\n` +
        `Task board: ${r.openTasks || 0} open, ${r.claimedTasks || 0} in progress.\n` +
        `Call the hive \`status\` tool for the full picture, and \`whoami\` to see who you can coordinate with.`;
    }
  }

  const orientation =
    `You are running as one instance in a HIVEMIND for project "${group.label}". ` +
    `Other Claude Code instances working in this same project can collaborate with you in real time ` +
    `through the hive tools: whoami/peers (presence), send/broadcast/inbox/wait (messaging & sync), ` +
    `share/recall (shared context blackboard), task_post/task_list/task_claim/task_update (shared work board), ` +
    `lock/unlock and elect (avoid collisions / pick a single owner), barrier (lockstep phases), and changes/status (awareness). ` +
    `When a task is large, consider splitting it onto the task board so peers can work in parallel, and use share to keep one source of truth.` +
    live;

  emitContext('SessionStart', orientation);
})().catch(() => process.exit(0));
