'use strict';

// Helpers shared by the hook scripts. Hooks are short-lived processes that read
// a JSON event on stdin and may print a JSON directive on stdout. They must be
// fast and must never break the user's session, so everything here fails soft.

const path = require('path');

function readStdinJson() {
  return new Promise((resolve) => {
    let buf = '';
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      try {
        resolve(buf ? JSON.parse(buf) : {});
      } catch (_) {
        resolve({});
      }
    };
    // Guard against a stdin that never closes.
    const t = setTimeout(finish, 1500);
    if (t.unref) t.unref();
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => (buf += d));
    process.stdin.on('end', () => {
      clearTimeout(t);
      finish();
    });
    process.stdin.on('error', () => {
      clearTimeout(t);
      finish();
    });
  });
}

// A stable, human-readable label for a session, consistent across all hook
// invocations of that session (they all share session_id). Used as the "who"
// in edit-intent and change-feed records, since hooks cannot see the MCP
// server's hive name.
function sessionLabel(cwd, sessionId) {
  const base = cwd ? path.basename(cwd) : 'session';
  const tag = String(sessionId || '').replace(/[^a-zA-Z0-9]/g, '').slice(0, 4) || 'xxxx';
  return `${base}:${tag}`;
}

// Emit a SessionStart/UserPromptSubmit-style context directive and exit cleanly.
function emitContext(eventName, contextText) {
  if (contextText) {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: { hookEventName: eventName, additionalContext: contextText },
      }) + '\n'
    );
  }
  process.exit(0);
}

module.exports = { readStdinJson, sessionLabel, emitContext };
