'use strict';

// PostToolUse hook (Edit|Write|MultiEdit): record a successful file edit into
// the hive's shared change feed so peers can see what just moved in the repo.
// Pure fire-and-forget; never affects the tool result.

const C = require('../lib/common');
const { quickRequest } = require('../lib/hub-client');
const { readStdinJson, sessionLabel } = require('../lib/hook-util');

(async () => {
  const evt = await readStdinJson();
  const file = evt.tool_input && (evt.tool_input.file_path || evt.tool_input.path);
  if (!file) process.exit(0);

  const group = C.groupFor(evt.cwd);
  const who = sessionLabel(evt.cwd, evt.session_id);

  await quickRequest(
    'record_change',
    { group: group.id, groupLabel: group.label, who, file, tool: evt.tool_name || 'edit' },
    { timeoutMs: 700 }
  );
  process.exit(0);
})().catch(() => process.exit(0));
