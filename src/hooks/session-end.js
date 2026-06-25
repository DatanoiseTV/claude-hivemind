'use strict';

// SessionEnd hook: clear this session's mirrored tasks from the hive board and
// tidy up its digest cursor. Presence cleanup is handled by the hub when the MCP
// server's socket closes, so there is no other hive state to unwind here.

const fs = require('fs');
const C = require('../lib/common');
const { quickRequest } = require('../lib/hub-client');
const { readStdinJson } = require('../lib/hook-util');

(async () => {
  const evt = await readStdinJson();
  const group = C.groupFor(evt.cwd);
  await quickRequest(
    'mirror_clear',
    { group: group.id, groupLabel: group.label, sessionKey: evt.session_id },
    { timeoutMs: 700 }
  );
  try {
    fs.unlinkSync(C.cursorPath(evt.session_id));
  } catch (_) {
    /* ignore */
  }
  process.exit(0);
})().catch(() => process.exit(0));
