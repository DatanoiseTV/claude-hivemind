'use strict';

// Smoke test for the MCP stdio layer: spawn the real mcp-server, perform the
// MCP handshake, list tools, and call a few that round-trip through the hub.
// Verifies the JSON-RPC plumbing and the tool->hub op wiring.

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const readline = require('readline');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hivemcp-'));
const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hiveproj-'));
const env = { ...process.env, XDG_RUNTIME_DIR: tmp, CLAUDE_PROJECT_DIR: projectDir, HIVEMIND_NAME: 'smoke-agent' };

const child = spawn(process.execPath, [path.join(__dirname, '..', 'src', 'mcp-server.js')], {
  env,
  stdio: ['pipe', 'pipe', 'inherit'],
});

const pending = new Map();
const rl = readline.createInterface({ input: child.stdout });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (_) {
    return;
  }
  if (msg.id != null && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id);
    pending.delete(msg.id);
    resolve(msg);
  }
});

let seq = 0;
function rpc(method, params) {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 8000);
  });
}
function notify(method, params) {
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
}

let passed = 0;
function assert(cond, name) {
  if (!cond) throw new Error(`FAILED: ${name}`);
  passed++;
  console.log(`  ok  ${name}`);
}
const textOf = (res) => (res.result && res.result.content && res.result.content[0] && res.result.content[0].text) || '';

async function main() {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'smoke', version: '0' } });
  assert(init.result && init.result.serverInfo && init.result.serverInfo.name === 'hivemind', 'initialize returns serverInfo');
  assert(init.result.capabilities && init.result.capabilities.tools, 'server advertises tools capability');
  notify('notifications/initialized', {});

  const list = await rpc('tools/list', {});
  const names = (list.result.tools || []).map((t) => t.name);
  assert(names.includes('whoami') && names.includes('task_post') && names.includes('barrier'), 'tools/list exposes the hive toolset');

  const who = await rpc('tools/call', { name: 'whoami', arguments: {} });
  assert(textOf(who).includes('smoke-agent'), 'whoami reflects HIVEMIND_NAME');

  const post = await rpc('tools/call', { name: 'task_post', arguments: { title: 'wire a button', detail: 'in header' } });
  assert(/Posted task t\d+/.test(textOf(post)), 'task_post creates a task via the hub');

  const tlist = await rpc('tools/call', { name: 'task_list', arguments: {} });
  assert(textOf(tlist).includes('wire a button'), 'task_list shows the posted task');

  const share = await rpc('tools/call', { name: 'share', arguments: { key: 'plan', value: 'do X then Y', summary: 'the plan' } });
  assert(textOf(share).toLowerCase().includes('shared'), 'share publishes context');

  const recall = await rpc('tools/call', { name: 'recall', arguments: { key: 'plan' } });
  assert(textOf(recall).includes('do X then Y'), 'recall returns shared context');

  const status = await rpc('tools/call', { name: 'status', arguments: {} });
  assert(textOf(status).toLowerCase().includes('hive'), 'status renders an overview');

  console.log(`\nALL ${passed} MCP CHECKS PASSED`);
}

main()
  .then(async () => {
    child.kill('SIGTERM');
    // Shut the autostarted hub down too.
    const { quickRequest } = require('../src/lib/hub-client');
    process.env.XDG_RUNTIME_DIR = tmp;
    await quickRequest('shutdown', {}, { timeoutMs: 500 }).catch(() => {});
    setTimeout(() => {
      try { fs.rmSync(tmp, { recursive: true, force: true }); fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
      process.exit(0);
    }, 200);
  })
  .catch((e) => {
    console.error('\n' + e.message);
    child.kill('SIGKILL');
    setTimeout(() => process.exit(1), 200);
  });
