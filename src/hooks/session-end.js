'use strict';

// SessionEnd hook: tidy up this session's digest cursor file. Presence cleanup
// is handled by the hub when the MCP server's socket closes, so there is no
// hive state to unwind here.

const fs = require('fs');
const C = require('../lib/common');
const { readStdinJson } = require('../lib/hook-util');

(async () => {
  const evt = await readStdinJson();
  try {
    fs.unlinkSync(C.cursorPath(evt.session_id));
  } catch (_) {
    /* ignore */
  }
  process.exit(0);
})().catch(() => process.exit(0));
