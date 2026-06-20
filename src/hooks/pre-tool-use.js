'use strict';

// PreToolUse hook (Edit|Write|MultiEdit): advisory cross-instance edit guard.
// Before this instance edits a file, ask the hub whether a *different* session
// in the same project touched the same file within the conflict window. If so,
// surface an "ask" decision so the user can avoid two instances clobbering one
// file. Otherwise stay out of the way (allow).
//
// Disable with HIVEMIND_EDIT_GUARD=off. Fails open: any error or unreachable
// hub allows the edit.

const C = require('../lib/common');
const { quickRequest } = require('../lib/hub-client');
const { readStdinJson, sessionLabel } = require('../lib/hook-util');

function allow() {
  process.exit(0); // no output -> default permission flow
}

function ask(reason) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'ask',
        permissionDecisionReason: reason,
      },
    }) + '\n'
  );
  process.exit(0);
}

(async () => {
  if ((process.env.HIVEMIND_EDIT_GUARD || '').toLowerCase() === 'off') allow();

  const evt = await readStdinJson();
  const file = evt.tool_input && (evt.tool_input.file_path || evt.tool_input.path);
  if (!file) allow();

  const group = C.groupFor(evt.cwd);
  const who = sessionLabel(evt.cwd, evt.session_id);

  const r = await quickRequest(
    'edit_intent',
    { group: group.id, groupLabel: group.label, sessionKey: evt.session_id || who, who, file },
    { timeoutMs: 800 }
  );

  if (r && r.ok && r.conflict) {
    const ago = Math.round((r.conflict.agoMs || 0) / 1000);
    ask(
      `Another Claude instance in this project (${r.conflict.who}) edited ${file} ${ago}s ago. ` +
        `Proceeding may clobber its work. Confirm you want to edit it too, or coordinate via the hive (lock/inbox).`
    );
  }
  allow();
})().catch(() => process.exit(0));
