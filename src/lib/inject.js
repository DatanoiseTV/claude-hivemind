'use strict';

// Inject text (a prompt) into another terminal session — the mechanism behind
// `dispatch`, which lets one instance type into another Claude Code window and
// press Enter.
//
// SAFETY: this is powerful. Injecting a prompt makes the target agent run a real
// turn (spending tokens and possibly taking actions) without its own user typing
// anything. So a window is only addressable if its user opted in by setting
// HIVEMIND_ALLOW_DISPATCH=1 (which is what makes it register an input channel),
// and dispatch is always an explicit action — nothing here fires automatically.
//
// Supported channels: tmux panes (any platform) and iTerm2 sessions (macOS).

const { execFile } = require('child_process');

function isTruthy(v) {
  return ['1', 'true', 'yes', 'on'].includes(String(v || '').toLowerCase());
}

// Detect this process's terminal input channel, but ONLY if dispatch is allowed.
// Returns { type, ref } or null. `ref` is a tmux pane id (%N) or iTerm session
// UUID — both uniquely address a session for the current user.
function detectInputChannel(env = process.env) {
  if (!isTruthy(env.HIVEMIND_ALLOW_DISPATCH)) return null;
  if (env.TMUX_PANE && /^%\d+$/.test(env.TMUX_PANE)) {
    return { type: 'tmux', ref: env.TMUX_PANE };
  }
  if (env.ITERM_SESSION_ID) {
    // Format is "w<win>t<tab>p<pane>:<UUID>"; the UUID is `id of session`.
    const uuid = String(env.ITERM_SESSION_ID).split(':').pop();
    if (/^[0-9A-Fa-f-]{36}$/.test(uuid)) return { type: 'iterm', ref: uuid };
  }
  return null;
}

// Prompts are injected as a single line. Collapse newlines and strip control
// characters so nothing breaks the send or the AppleScript string.
function sanitize(text) {
  return String(text == null ? '' : text)
    .replace(/[\r\n]+/g, ' ')
    .slice(0, 4000);
}

function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 5000 }, (err, stdout, stderr) => {
      resolve({ err, stdout: String(stdout || ''), stderr: String(stderr || '') });
    });
  });
}

async function injectTmux(ref, text, submit) {
  if (!/^%\d+$/.test(ref)) return { ok: false, error: 'bad tmux pane id' };
  const r1 = await run('tmux', ['send-keys', '-t', ref, '-l', '--', text]);
  if (r1.err) return { ok: false, error: `tmux send-keys failed: ${r1.stderr || r1.err.message}` };
  if (submit) {
    const r2 = await run('tmux', ['send-keys', '-t', ref, 'Enter']);
    if (r2.err) return { ok: false, error: `tmux Enter failed: ${r2.stderr || r2.err.message}` };
  }
  return { ok: true, via: 'tmux' };
}

async function injectITerm(ref, text, submit) {
  if (!/^[0-9A-Fa-f-]{36}$/.test(ref)) return { ok: false, error: 'bad iTerm session id' };
  const esc = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  // `write text` submits (appends a newline) by default; suppress with `newline no`.
  const writeCmd = submit ? `write text "${esc}"` : `write text "${esc}" newline no`;
  const script = [
    'tell application "iTerm2"',
    '  repeat with w in windows',
    '    repeat with t in tabs of w',
    '      repeat with s in sessions of t',
    `        if (id of s) is "${ref}" then`,
    `          tell s to ${writeCmd}`,
    '          return "ok"',
    '        end if',
    '      end repeat',
    '    end repeat',
    '  end repeat',
    'end tell',
    'return "notfound"',
  ].join('\n');
  const r = await run('osascript', ['-e', script]);
  if (r.err) {
    const hint = /not authorized|1743|assistive|automation/i.test(r.stderr)
      ? ' (grant Automation permission to control iTerm: System Settings -> Privacy & Security -> Automation)'
      : '';
    return { ok: false, error: `osascript failed: ${r.stderr || r.err.message}${hint}` };
  }
  if (r.stdout.trim() === 'notfound') return { ok: false, error: 'target iTerm session not found (window closed?)' };
  return { ok: true, via: 'iterm' };
}

// Inject `text` into the given channel. `submit` (default true) presses Enter.
async function inject(channel, text, submit = true) {
  if (!channel || !channel.type) return { ok: false, error: 'no input channel' };
  const clean = sanitize(text);
  if (!clean) return { ok: false, error: 'empty text' };
  if (channel.type === 'tmux') return injectTmux(channel.ref, clean, submit);
  if (channel.type === 'iterm') return injectITerm(channel.ref, clean, submit);
  return { ok: false, error: `unsupported channel type: ${channel.type}` };
}

module.exports = { detectInputChannel, inject, isTruthy, sanitize };
