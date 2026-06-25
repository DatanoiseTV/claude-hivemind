'use strict';

// PostToolUse hook (TaskCreate | TaskUpdate | TaskList): mirror this instance's
// native task/todo list onto the hive board, so the board fills from the
// planning agents already do — no new habit and no token cost. Mirrored tasks
// are owned by this session, shown for awareness, and never claimable by others.
//
// Parsing is defensive: Claude Code's tool result may arrive as tool_output or
// tool_result.content, as an object or a JSON string, and TaskUpdate ids appear
// as taskId / id / task_id depending on the path.

const C = require('../lib/common');
const { quickRequest } = require('../lib/hub-client');
const { readStdinJson, sessionLabel } = require('../lib/hook-util');

function resultObj(evt) {
  let r = evt.tool_output != null ? evt.tool_output : evt.tool_result && evt.tool_result.content;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch (_) {
      r = {};
    }
  }
  return r && typeof r === 'object' ? r : {};
}

(async () => {
  const evt = await readStdinJson();
  const tool = evt.tool_name;
  const input = evt.tool_input || {};
  const res = resultObj(evt);
  const group = C.groupFor(evt.cwd);
  const base = {
    group: group.id,
    groupLabel: group.label,
    sessionKey: evt.session_id || sessionLabel(evt.cwd, evt.session_id),
    who: sessionLabel(evt.cwd, evt.session_id),
  };

  let payload = null;
  if (tool === 'TaskCreate') {
    const id = (res.task && res.task.id) || res.id;
    if (id) payload = { ...base, kind: 'create', item: { nativeId: id, subject: input.subject, status: 'pending' } };
  } else if (tool === 'TaskUpdate') {
    const id = input.taskId || input.id || input.task_id || (res.task && res.task.id);
    if (id) payload = { ...base, kind: 'update', item: { nativeId: id, status: input.status, subject: input.subject } };
  } else if (tool === 'TaskList') {
    const tasks = res.tasks || (res.task && [res.task]) || [];
    const items = tasks
      .filter((t) => t && t.id)
      .map((t) => ({ nativeId: t.id, subject: t.subject, status: t.status, blockedBy: t.blockedBy || [] }));
    payload = { ...base, kind: 'list', items };
  }

  if (payload) {
    await quickRequest('mirror_tasks', payload, { timeoutMs: 800 });
  }
  process.exit(0);
})().catch(() => process.exit(0));
