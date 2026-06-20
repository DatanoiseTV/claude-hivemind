'use strict';

// MCP stdio server that bridges one Claude Code instance to the hive hub.
//
// On startup it derives this instance's identity (a fresh agent id, a friendly
// name, and the project group from CLAUDE_PROJECT_DIR / cwd), opens a
// persistent connection to the hub, and registers. That live connection IS the
// instance's presence in the hive — when this process dies, the hub reaps it.
//
// It then speaks MCP over stdio and exposes the hive toolset to the agent.
//
// STDOUT IS SACRED: only newline-delimited JSON-RPC may be written there. All
// diagnostics go to stderr (captured in the hub log dir is the hub's job; here
// stderr is surfaced by Claude Code's MCP logging).

const C = require('./lib/common');
const { PersistentClient } = require('./lib/hub-client');

const SERVER_NAME = 'hivemind';
const SERVER_VERSION = '0.5.1';
const DEFAULT_PROTOCOL = '2025-06-18';

function logErr(msg) {
  process.stderr.write(`[hivemind-mcp] ${msg}\n`);
}

// --- Identity ---------------------------------------------------------------

// Project dir resolution is IDE-agnostic: HIVEMIND_PROJECT_DIR (any tool) wins,
// then CLAUDE_PROJECT_DIR (Claude Code sets this), else cwd. Two instances in
// the same git work-tree join the same hive no matter which IDE launched them.
const projectDir = process.env.HIVEMIND_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd();
const group = C.groupFor(projectDir);

// Which coding environment this instance is — so a mixed fleet (Claude Code +
// OpenCode + Cursor + ...) is legible, and you can see which model is where.
const clientName =
  process.env.HIVEMIND_CLIENT || (process.env.CLAUDE_PROJECT_DIR ? 'claude-code' : 'mcp');

const agent = {
  id: C.genId('a'),
  name: process.env.HIVEMIND_NAME || C.randomName(),
  group: group.id,
  groupLabel: group.label,
  cwd: group.dir,
  pid: process.pid,
  client: clientName,
  model: process.env.HIVEMIND_MODEL || '',
  // Optional capability tags (e.g. "rust,frontend,tests") so the task board can
  // route work to the instance best suited for it.
  capabilities: (process.env.HIVEMIND_CAPS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
};

const client = new PersistentClient({ agent, log: logErr });
// Begin connecting immediately so the first tool call is fast. Failure here is
// non-fatal; tool calls retry the connection.
client.ensureConnected().catch((e) => logErr(`initial connect deferred: ${e.message}`));

// --- Formatting helpers -----------------------------------------------------

function ageStr(ts) {
  const s = Math.max(0, Math.round((C.now() - ts) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  return `${Math.round(s / 3600)}h ago`;
}

function fmtPeers(peers) {
  if (!peers || !peers.length) return 'No other instances are in this hive right now.';
  return peers
    .map((p) => {
      const env = [p.client, p.model].filter(Boolean).join('/');
      const envStr = env ? ` (${env})` : '';
      const caps = p.capabilities && p.capabilities.length ? ` {${p.capabilities.join(',')}}` : '';
      const doing = p.currentTask ? ` — working on ${p.currentTask}` : p.status && p.status !== 'idle' ? ` [${p.status}]` : '';
      return `- ${p.name}${envStr}${caps}${doing} (seen ${ageStr(p.lastSeen)})`;
    })
    .join('\n');
}

function fmtParticipants(participants) {
  if (!participants || !participants.length) return '';
  return (
    `\n\n${participants.length} named participant(s) / subagent(s):\n` +
    participants.map((p) => `- ${p.name} (sub${p.pending ? `, ${p.pending} pending` : ''})`).join('\n')
  );
}

function fmtTasks(tasks) {
  if (!tasks || !tasks.length) return 'Task board is empty.';
  const order = { open: 0, claimed: 1, in_progress: 1, done: 2, failed: 3 };
  return [...tasks]
    .sort((a, b) => (order[a.status] ?? 9) - (order[b.status] ?? 9) || (b.priority || 0) - (a.priority || 0))
    .map((t) => {
      const who = t.claimedBy ? ` @${t.claimedBy}` : '';
      const tags = t.tags && t.tags.length ? ` #${t.tags.join(' #')}` : '';
      const prio = t.priority ? ` p${t.priority}` : '';
      let state = t.status.toUpperCase();
      if (t.status === 'open') state = t.ready ? 'READY' : `BLOCKED(${(t.blockedBy || []).join(',')})`;
      return `- [${t.id}] ${state}${prio}${who}${tags}: ${t.title}${t.detail ? `\n    ${t.detail}` : ''}`;
    })
    .join('\n');
}

function fmtMessages(messages) {
  if (!messages || !messages.length) return null;
  return messages
    .map((m) => `- (${ageStr(m.ts)}) ${m.fromName}${m.kind === 'system' ? ' [system]' : ''}: ${m.body}`)
    .join('\n');
}

function text(s) {
  return { content: [{ type: 'text', text: s }] };
}

// --- Tool definitions -------------------------------------------------------
// Each tool: JSON Schema for inputs + an async handler returning result text.

const TOOLS = [
  {
    name: 'whoami',
    description:
      'Show your identity in the hive (your name, project group) and the other Claude instances currently connected to the same project. Call this first to see who you can collaborate with.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const r = await client.request('whoami');
      const peers = r.peers || [];
      return text(
        `You are "${agent.name}" in hive "${r.group.label}" (group ${r.group.id}).\n` +
          `Project: ${agent.cwd}\n\n` +
          `${peers.length} peer instance(s) connected:\n${fmtPeers(peers)}` +
          fmtParticipants(r.participants)
      );
    },
  },
  {
    name: 'peers',
    description: 'List the other Claude Code instances currently active in this project hive, with their working directory and status.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const r = await client.request('peers');
      return text(fmtPeers(r.peers) + fmtParticipants(r.participants));
    },
  },
  {
    name: 'send',
    description:
      'Send a direct message to one peer by name (e.g. "swift-otter"). The recipient can be another connected instance OR a named participant such as a subagent (a name with no live connection gets a mailbox it can drain). Use `as` to send under a sub-identity so multiple agents/subagents in one session can address each other distinctly.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient name (a peer instance, or any named participant / subagent).' },
        text: { type: 'string', description: 'Message body.' },
        as: { type: 'string', description: 'Optional: send under this sub-identity (e.g. a subagent name) instead of this instance.' },
      },
      required: ['to', 'text'],
      additionalProperties: false,
    },
    async handler(args) {
      const r = await client.request('send', { to: args.to, body: args.text, as: args.as });
      return text(`Delivered to ${r.to}.`);
    },
  },
  {
    name: 'broadcast',
    description:
      'Send a message to every other instance and active named participant (subagent) in this project hive at once. Use `as` to broadcast under a sub-identity.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Message body.' },
        as: { type: 'string', description: 'Optional sub-identity to broadcast as.' },
      },
      required: ['text'],
      additionalProperties: false,
    },
    async handler(args) {
      const r = await client.request('broadcast', { body: args.text, as: args.as });
      return text(`Broadcast to ${r.delivered} recipient(s).`);
    },
  },
  {
    name: 'inbox',
    description:
      'Retrieve and clear your pending messages (direct messages and broadcasts). Pass `as` to drain a named participant\'s mailbox instead — this is how a subagent checks messages sent to its own name. Non-blocking.',
    inputSchema: {
      type: 'object',
      properties: {
        as: { type: 'string', description: 'Optional: drain this named participant\'s (subagent\'s) mailbox instead of your own inbox.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const r = await client.request('inbox', { as: args.as });
      const m = fmtMessages(r.messages);
      return text(m ? `${r.messages.length} new message(s):\n${m}` : 'Inbox is empty.');
    },
  },
  {
    name: 'wait',
    description:
      'Block until something happens in the hive, then return immediately. Use to synchronize with peers in real time — wait for a teammate to reply, or (as a worker) wait for a task to become ready. Pass `as` to wait on a named participant\'s (subagent\'s) mailbox. Returns as soon as a matching event arrives, or after the timeout.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_seconds: { type: 'number', description: 'Max seconds to block (default 30, max 300).' },
        want: {
          type: 'array',
          items: { type: 'string', enum: ['message', 'task', 'broadcast'] },
          description: 'Which events wake you. "message" = someone messaged you; "task" = a ready task is available to claim; "broadcast" = any new group broadcast. Default ["message"].',
        },
        as: { type: 'string', description: 'Optional: wait on this named participant\'s (subagent\'s) mailbox.' },
      },
      additionalProperties: false,
    },
    async handler(args) {
      const secs = Math.min(Math.max(Number(args.timeout_seconds) || 30, 1), 300);
      const want = Array.isArray(args.want) && args.want.length ? args.want : ['message'];
      const r = await client.request('wait', { timeout_ms: secs * 1000, want, as: args.as }, secs * 1000 + 5000);
      if (r.timeout) return text(`No matching activity within ${secs}s. (You can wait again.)`);
      const parts = [];
      const m = fmtMessages(r.messages);
      if (m) parts.push(`Messages:\n${m}`);
      if (r.tasks && r.tasks.length) parts.push(`Open tasks available to claim:\n${fmtTasks(r.tasks)}`);
      if (r.broadcasts && r.broadcasts.length) {
        parts.push('New broadcasts:\n' + r.broadcasts.map((b) => `- ${b.fromName}: ${b.body}`).join('\n'));
      }
      return text(parts.length ? parts.join('\n\n') : 'Woke with no payload.');
    },
  },
  {
    name: 'share',
    description:
      'Publish a piece of shared context to the hive blackboard under a key (e.g. "api-contract", "db-schema-notes", "decided-auth-approach"). Other instances retrieve it with recall. Use to share findings, decisions, conventions, or any context the whole hive should work from — this is how the megabrain keeps one source of truth.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Short stable key to store under.' },
        value: { type: 'string', description: 'The context to share (text, can be long).' },
        summary: { type: 'string', description: 'Optional one-line summary shown in listings.' },
      },
      required: ['key', 'value'],
      additionalProperties: false,
    },
    async handler(args) {
      await client.request('share', { key: args.key, value: args.value, summary: args.summary || '' });
      return text(`Shared context under "${args.key}". Peers can read it with recall.`);
    },
  },
  {
    name: 'recall',
    description:
      'Read shared context from the hive blackboard. With a key, returns that entry\'s full value. Without a key, lists all available keys with summaries so you can see what the hive knows.',
    inputSchema: {
      type: 'object',
      properties: { key: { type: 'string', description: 'Key to read. Omit to list all keys.' } },
      additionalProperties: false,
    },
    async handler(args) {
      if (args.key) {
        const r = await client.request('recall', { key: args.key });
        if (!r.found) return text(`No shared context under "${args.key}".`);
        return text(`# ${args.key} (shared by ${r.by}, ${ageStr(r.ts)})\n${r.summary ? r.summary + '\n\n' : ''}${r.value}`);
      }
      const r = await client.request('list_notes');
      if (!r.notes || !r.notes.length) return text('No shared context yet. Use share to add some.');
      return text(
        'Shared context keys:\n' +
          r.notes.map((n) => `- ${n.key}${n.summary ? ` — ${n.summary}` : ''} (by ${n.by}, ${ageStr(n.ts)})`).join('\n')
      );
    },
  },
  {
    name: 'task_post',
    description:
      'Post a unit of work to the shared task board for any instance (including you) to claim and execute. Supports dependencies (deps), so you can post a whole plan at once and the board will only let workers claim a task once its prerequisites are done. Use priority and tags to steer which instance picks it up first.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short task title.' },
        detail: { type: 'string', description: 'Optional fuller description / acceptance criteria.' },
        deps: {
          type: 'array',
          items: { type: 'string' },
          description: 'Task ids that must be "done" before this task becomes claimable (e.g. ["t1","t2"]).',
        },
        priority: { type: 'number', description: 'Higher = claimed first among ready tasks (default 0).' },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Capability tags (e.g. ["frontend"]); instances with matching capabilities are routed these first.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
    async handler(args) {
      const r = await client.request('task_post', {
        title: args.title,
        detail: args.detail || '',
        deps: args.deps || [],
        priority: args.priority || 0,
        tags: args.tags || [],
      });
      const dep = r.task.blockedBy && r.task.blockedBy.length ? ` (waiting on ${r.task.blockedBy.join(', ')})` : '';
      return text(`Posted task ${r.task.id}: ${r.task.title}${dep}`);
    },
  },
  {
    name: 'task_list',
    description: 'Show the shared task board: every task with its status (open/claimed/in_progress/done/failed), whether it is ready to claim (deps satisfied), what it is blocked by, priority, tags, and who owns it.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const r = await client.request('task_list');
      return text(fmtTasks(r.tasks));
    },
  },
  {
    name: 'task_next',
    description:
      'The smart way to grab work: atomically claim the single best ready task for you — highest priority, matching your capabilities, oldest first — skipping anything blocked by unfinished dependencies. This is the one call a worker loop needs; it replaces list-then-pick-then-claim.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const r = await client.request('task_next');
      if (!r.task) return text('No ready task available right now. Use the wait tool with want ["task"] to block until one appears.');
      return text(`Claimed ${r.task.id}: ${r.task.title}. Work it, then mark done with task_update. Call task_next again for more.`);
    },
  },
  {
    name: 'task_claim',
    description:
      'Atomically claim a specific open task by id so no other instance picks it up (exactly one instance wins). Fails if the task is blocked by unfinished dependencies. Omit task_id to claim the best ready task instead (same as task_next).',
    inputSchema: {
      type: 'object',
      properties: { task_id: { type: 'string', description: 'Task id (e.g. "t3"). Omit to auto-pick the best ready task.' } },
      additionalProperties: false,
    },
    async handler(args) {
      const r = await client.request('task_claim', args.task_id ? { task_id: args.task_id } : {});
      if (!r.task) return text('No ready task available to claim.');
      return text(`Claimed ${r.task.id}: ${r.task.title}. Mark it in_progress/done with task_update.`);
    },
  },
  {
    name: 'task_update',
    description: 'Update a task you are working on: set status to in_progress, done, or failed, and optionally attach a note (e.g. a result summary or where you left off).',
    inputSchema: {
      type: 'object',
      properties: {
        task_id: { type: 'string' },
        status: { type: 'string', enum: ['open', 'in_progress', 'done', 'failed'] },
        note: { type: 'string', description: 'Optional note / result.' },
      },
      required: ['task_id'],
      additionalProperties: false,
    },
    async handler(args) {
      const r = await client.request('task_update', { task_id: args.task_id, status: args.status, note: args.note });
      return text(`Task ${r.task.id} is now ${r.task.status}.`);
    },
  },
  {
    name: 'lock',
    description:
      'Acquire an advisory lock on a named resource (typically a file path or module) so peers know not to touch it while you work. Returns whether you got it and, if not, who holds it. Prevents two instances clobbering the same file.',
    inputSchema: {
      type: 'object',
      properties: {
        resource: { type: 'string', description: 'Resource name, e.g. "src/auth.ts".' },
        ttl_seconds: { type: 'number', description: 'Auto-release after this many seconds (default 900).' },
      },
      required: ['resource'],
      additionalProperties: false,
    },
    async handler(args) {
      const ttl_ms = args.ttl_seconds ? Number(args.ttl_seconds) * 1000 : undefined;
      const r = await client.request('lock', { resource: args.resource, ttl_ms });
      if (r.acquired) return text(`Locked "${args.resource}". Release with unlock when done.`);
      return text(`Could not lock "${args.resource}" — held by ${r.holder} since ${ageStr(r.since)}. Coordinate or wait.`);
    },
  },
  {
    name: 'unlock',
    description: 'Release an advisory lock you hold on a resource.',
    inputSchema: {
      type: 'object',
      properties: { resource: { type: 'string' } },
      required: ['resource'],
      additionalProperties: false,
    },
    async handler(args) {
      const r = await client.request('unlock', { resource: args.resource });
      return text(r.released ? `Released "${args.resource}".` : `Not released (${r.reason}).`);
    },
  },
  {
    name: 'elect',
    description:
      'Claim a named singleton role for the hive (default "leader"). Exactly one instance holds a role at a time; the first to claim wins and keeps it until it disconnects or releases it. Use to ensure a one-time job (deps install, DB migration, scaffolding) is done by exactly one instance.',
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string', description: 'Role name (default "leader").' } },
      additionalProperties: false,
    },
    async handler(args) {
      const r = await client.request('elect', { role: args.role || 'leader' });
      if (r.leader) return text(`You hold the "${r.role}" role. You are responsible for it. Release with release_role.`);
      return text(`"${r.role}" is held by ${r.holder}. Defer to them; do not duplicate that work.`);
    },
  },
  {
    name: 'release_role',
    description: 'Give up a singleton role you hold so another instance can take it.',
    inputSchema: {
      type: 'object',
      properties: { role: { type: 'string' } },
      additionalProperties: false,
    },
    async handler(args) {
      const r = await client.request('release_role', { role: args.role || 'leader' });
      return text(r.released ? `Released "${args.role || 'leader'}".` : 'You did not hold that role.');
    },
  },
  {
    name: 'barrier',
    description:
      'Synchronization barrier: block until `parties` instances have all reached the same named barrier, then release together. Use to keep a fleet in lockstep across phases — e.g. everyone finishes "design" before anyone starts "implement". All participants must call with the same name and parties count.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Barrier name shared by all participants.' },
        parties: { type: 'number', description: 'How many instances must arrive before release.' },
        timeout_seconds: { type: 'number', description: 'Max seconds to wait (default 60, max 3600).' },
      },
      required: ['name', 'parties'],
      additionalProperties: false,
    },
    async handler(args) {
      const secs = Math.min(Math.max(Number(args.timeout_seconds) || 60, 1), 3600);
      const r = await client.request(
        'barrier',
        { name: args.name, parties: args.parties, timeout_ms: secs * 1000 },
        secs * 1000 + 5000
      );
      if (r.released) return text(`Barrier "${r.name}" released — all ${r.parties} instances arrived. Proceed.`);
      return text(`Barrier "${r.name}" timed out (${r.arrived}/${r.parties} arrived). Decide whether to proceed or retry.`);
    },
  },
  {
    name: 'changes',
    description:
      'List files recently edited across this project hive (which session touched what, and when), newest last. Use to stay aware of churn so you build on fresh state and avoid conflicts. Entries are labelled by editing session; one of them may be your own.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const r = await client.request('list_changes');
      const changes = r.changes || [];
      if (!changes.length) return text('No recent file edits recorded in this hive.');
      return text(
        'Recent file edits in this hive (by session):\n' +
          changes.slice(-40).map((c) => `- ${c.who} ${c.tool} ${c.file} (${ageStr(c.ts)})`).join('\n')
      );
    },
  },
  {
    name: 'status',
    description: 'Full hive overview for this project: connected instances, the task board, shared-context keys, and active locks. The "what is the whole hive doing" view.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    async handler() {
      const r = await client.request('status', { group: group.id });
      const snap = (r.groups && r.groups[0]) || null;
      if (!snap) return text('Hive is empty.');
      const locks = snap.locks && snap.locks.length
        ? snap.locks.map((l) => `- ${l.resource} (held by ${l.holder})`).join('\n')
        : 'none';
      const notes = snap.notes && snap.notes.length
        ? snap.notes.map((n) => `- ${n.key}${n.summary ? ` — ${n.summary}` : ''}`).join('\n')
        : 'none';
      return text(
        `Hive "${snap.group.label}" — ${snap.agents.length} instance(s)\n\n` +
          `Instances:\n${fmtPeers(snap.agents.filter((a) => a.id !== agent.id))}\n\n` +
          `Task board:\n${fmtTasks(snap.tasks)}\n\n` +
          `Shared context:\n${notes}\n\n` +
          `Locks:\n${locks}`
      );
    },
  },
];

const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));

// --- MCP stdio JSON-RPC plumbing -------------------------------------------

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + '\n');
}

function respond(id, result) {
  if (id == null) return;
  send({ jsonrpc: '2.0', id, result });
}

function respondError(id, code, message) {
  if (id == null) return;
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handleToolCall(id, params) {
  const name = params && params.name;
  const tool = TOOL_BY_NAME.get(name);
  if (!tool) {
    respond(id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
    return;
  }
  try {
    const result = await tool.handler(params.arguments || {});
    respond(id, result);
  } catch (e) {
    respond(id, {
      content: [{ type: 'text', text: `Hive error: ${e.message || String(e)}` }],
      isError: true,
    });
  }
}

function handleMessage(msg) {
  if (!msg || msg.jsonrpc !== '2.0') return;
  const { id, method, params } = msg;

  switch (method) {
    case 'initialize':
      respond(id, {
        protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case 'notifications/initialized':
    case 'notifications/cancelled':
      return; // notifications: no reply
    case 'ping':
      respond(id, {});
      return;
    case 'tools/list':
      respond(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })) });
      return;
    case 'tools/call':
      handleToolCall(id, params);
      return;
    case 'resources/list':
      respond(id, { resources: [] });
      return;
    case 'resources/templates/list':
      respond(id, { resourceTemplates: [] });
      return;
    case 'prompts/list':
      respond(id, { prompts: [] });
      return;
    default:
      if (id != null) respondError(id, -32601, `Method not found: ${method}`);
  }
}

const decode = C.lineDecoder(handleMessage);
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => decode(d));
process.stdin.on('end', () => shutdown(0));

async function shutdown(code) {
  try {
    await client.unregister();
  } catch (_) {
    /* ignore */
  }
  process.exit(code);
}

process.on('SIGTERM', () => shutdown(0));
process.on('SIGINT', () => shutdown(0));

logErr(`started for "${agent.name}" in group ${group.label} [${group.id}] cwd=${group.dir}`);
