# Hivemind

[![CI](https://github.com/DatanoiseTV/claude-hivemind/actions/workflows/ci.yml/badge.svg)](https://github.com/DatanoiseTV/claude-hivemind/actions/workflows/ci.yml)
[![License: PolyForm Noncommercial 1.0.0](https://img.shields.io/badge/license-PolyForm%20Noncommercial%201.0.0-blue.svg)](LICENSE)

A Claude Code plugin that lets **multiple coding-agent instances working in the
same project talk to each other in real time** and collaborate as one hive:
shared presence, messaging, a dependency-aware task board, a shared-context
blackboard, advisory file locks, leader election, and lockstep barriers — all
isolated per project, plus a live animated terminal dashboard that shows every
hive at once.

It is **not Claude-only**: the bundled MCP server is a universal adapter, so
OpenCode, Cursor, Cline, Zed, Windsurf — any MCP-capable IDE — can join the same
per-project hive, each running a different model. Run a fast cheap model on
mechanical tasks and a strong model on the hard ones, all coordinating over one
board. See [INTEGRATIONS.md](INTEGRATIONS.md).

```
┌─ HIVEMIND · hub up 12m · pid 4831 · proto v1 ───────────────────────────────┐
│  2 hives   5 instances   peak 7        msgs/s  ▁▂▅█▆▃▂▁▃▅█▆  3              │
│ 12 tasks   3 open  2 wip  7 done       edits/s ▁▁▃▂▅▁▁▃▂▅▁  1               │
│ 142 msgs   88 edits                                                         │
│ ● connected                                                                 │
└─────────────────────────────────────────────────────────────────────────────┘
┌ supercode · 3 inst ───────────────┐ ┌ api-gateway · 2 inst ────────────-────┐
│ ● swift-otter   src/hub.js        │ │ ● keen-lynx   writing tests           │
│ ● keen-lynx     src/ui.rs         │ │ ● bold-raven  cmd/server              │
│ ● bold-raven    monitor/          │ │ [██████░░░░] 3/5 done                 │
│ [████████░░] 4/5 done             │ │ 1 open 1 wip 3 done 0 fail   L1 C2    │
│ 2 open 1 wip 4 done 0 fail  L1 C3 │ │ ▂▅█▆▃▂▁                               │
│ ▁▂▅█▆▃▂▁                          │ │ ▁▁▃▂▅                                 │
│ swift-otter claimed t7            │ │ keen-lynx shared db-schema            │
└───────────────────────────────────┘ └─────────────────────────────────────-─┘
 q quit · ↑↓/jk select · b broadcast · p pause · msgs/edits
```

## What it actually does (and doesn't)

It is honest to be precise here, because "megabrain" can promise more than any
plugin can deliver.

**It does**: give every Claude Code instance you launch in a project a shared,
real-time coordination fabric. Instances see each other, message each other,
divide work over a shared task board, publish findings to a shared blackboard
so everyone works from one source of truth, avoid clobbering the same files,
and synchronize on barriers and long-polls. Run three Claudes on one repo and
they behave like a coordinated team instead of three strangers editing blind.

**It does not**: magically fan one prompt out across instances. Each instance is
still driven by its own conversation and its own turns. The speed-up comes from
*you* running several instances and them coordinating well — not from a single
chat secretly parallelizing itself. The `/hivemind:hive-plan` and
`/hivemind:hive-worker` commands make that division of labour one step.

## Architecture

```
  Claude Code #1 ─┐                         ┌─ hooks (session/prompt/edit)
  (MCP server) ───┤                         │   group-level, keyed by project
                  │   Unix domain socket    │
  Claude Code #2 ─┼──▶  Hub daemon  ◀───────┘
  (MCP server) ───┤   (one per user, in-mem)
                  │   state partitioned      ┌─ hivemind-monitor (ratatui)
  Claude Code #3 ─┘   by project "group"  ◀──┤   read-only dashboard + operator
                                             └─  broadcast
```

- **Hub** (`src/hub.js`) — a single per-user background daemon. Holds all hive
  state in memory, partitioned by **group** (one git work-tree = one group).
  It is disposable: nothing is persisted, it starts on demand, reaps instances
  the moment their socket closes, and exits after 60 minutes idle. Losing it
  loses only in-flight coordination state, never your work.
- **MCP server** (`src/mcp-server.js`) — launched per Claude session by the
  plugin. Its live socket to the hub *is* the instance's presence. It exposes
  the hive tools to the agent.
- **Hooks** (`src/hooks/`) — orient each new session, fold fresh peer activity
  into each turn, warn before two instances edit the same file, and record edits
  into a shared change feed. These work at the project-group level (keyed by
  `CLAUDE_PROJECT_DIR` + session id) because MCP servers aren't given a session
  id.
- **Monitor** (`monitor/`) — a standalone Rust + ratatui binary. Connects to the
  same socket and renders every hive at once. Any client can speak the simple
  NDJSON protocol; the monitor is one.

Everything in the plugin core is **dependency-free Node** (only Node built-ins),
so it runs with no `npm install`. The monitor is the only part that needs a
build, and it is optional.

## Install

The plugin lives in this repo, which is also a Claude Code plugin marketplace.

```
# In Claude Code:
/plugin marketplace add /path/to/supercode
/plugin install hivemind@hivemind
```

Or for local development without installing:

```
claude --plugin-dir /path/to/supercode
```

That's it — the MCP server, hooks, and commands load automatically. Open Claude
Code in two terminals in the same project and they find each other.

Requirements: Node ≥ 18 (Claude Code already needs it). The optional dashboard
needs a Rust toolchain (`rustup`).

## Using it

Once installed, every Claude session in a project is a hive member. Drive it with
natural language ("ask the other instance to take the frontend") or the commands:

| Command | What it does |
| --- | --- |
| `/hivemind:hive` | Who's online and how to collaborate |
| `/hivemind:hive-status` | Full board: peers, tasks, shared context, locks |
| `/hivemind:hive-plan <goal>` | Split a goal into tasks on the shared board |
| `/hivemind:hive-worker` | Claim and execute tasks until the board is empty |
| `/hivemind:hive-sync [intent]` | Announce intent, gather peers' before acting |
| `/hivemind:hive-broadcast <msg>` | Message every instance in the hive |
| `/hivemind:hive-share <key> :: <ctx>` | Publish shared context to the blackboard |

A typical fleet workflow:

1. In instance A: `/hivemind:hive-plan build the billing export feature`.
   It breaks the goal into tasks, posts them, and shares the plan.
2. In instances B and C: `/hivemind:hive-worker`. They claim open tasks, lock
   the files they touch, do the work, publish results, and mark tasks done.
3. Watch it all in `hivemind monitor`.

### The hive tools (exposed to the agent over MCP)

Presence & messaging: `whoami`, `peers`, `send`, `broadcast`, `inbox`, `wait`.
Shared context: `share`, `recall`. Task board: `task_post` (with `deps`,
`priority`, `tags`), `task_list`, `task_next`, `task_claim`, `task_update`.
Collision control: `lock`, `unlock`, `elect`, `release_role`. Sync: `barrier`.
Awareness: `changes`, `status`.

`wait` is the real-time primitive: an instance blocks on it and returns the
instant a relevant event arrives (a message, or a *ready* task for a worker), so
instances synchronize like a real team rather than polling.

**The task board is a dependency graph, not a flat list.** A task with `deps`
only becomes claimable once those dependencies are `done`, so a whole plan can be
posted at once and the hive will naturally serialize phases while running
independent work in parallel. `task_next` atomically claims the best *ready* task
for an instance — highest priority, matched to its capabilities — so a worker
loop is one call. Completing a task auto-unblocks its dependents and wakes any
waiting workers.

## The monitor

```
hivemind monitor          # builds on first run, then launches the dashboard
# or
cargo run --release --manifest-path monitor/Cargo.toml
```

An animated, live dashboard (~10 fps): every active project hive at once with
sparkline graphs (activity/sec and edits/sec, globally and per hive), animated
task-progress gauges, a spinner on every instance currently working, pulsing
presence dots, and cards that flash cyan the instant their hive does anything.
"Activity" includes turns, so an instance that is simply being used shows up even
when it isn't messaging or editing — and the environment/model of each instance
is shown, so a mixed Claude/OpenCode/Cursor fleet is legible at a glance. Keys:
`↑↓`/`jk` select a hive, **`Enter` to focus** a hive (full-screen detail: every
instance with capabilities + current task, the whole board with ready/blocked
state and dependencies, the feed, and recent file edits), `b` broadcast to the
selected hive as an operator, `p` pause, `q` quit.

No-build fallbacks (pure Node):

```
hivemind status      # one-shot snapshot
hivemind watch       # simple live line view
hivemind groups      # list active hives
hivemind stop        # shut the hub down
hivemind where       # socket / log paths
```

## Configuration

Environment variables (set them for a Claude session):

- `HIVEMIND_NAME` — give this instance a fixed name instead of a random one.
- `HIVEMIND_EDIT_GUARD=off` — disable the concurrent-edit `ask` prompt.

## Safety & isolation

- The hub listens only on a **Unix domain socket** under a per-user runtime dir
  (mode 0700, socket 0600). Nothing is exposed on the network.
- State is partitioned by project group; instances in different projects never
  see each other's messages, tasks, or context.
- All hooks **fail open**: if the hub is unreachable or slow, they no-op and
  never block your session. The edit guard only asks; it never denies.
- Queues, feeds, and the task board are bounded (high ceilings sized for large,
  long-running projects), so a runaway producer cannot exhaust memory; the hub
  prunes oldest completed tasks first and never drops live work.

## Performance

The hub is a single-threaded Node daemon over a Unix domain socket — local IPC,
no network stack. Measured on a developer Mac (`npm run bench`):

- **~150,000 messages/sec** sustained, lossless (with a live consumer draining).
- **~0.04 ms** median round-trip latency (p99 ~0.23 ms).

Messaging is never the bottleneck; the limit on "messages per second" in
practice is how fast the agents themselves choose to talk. Durable-state writes
are async and atomic, so persistence never stalls the message loop.

## Development

```
npm test                 # engine (28 checks) + MCP stdio (9) + durability (4)
npm run bench            # throughput / latency benchmark
npm run test:engine
cargo test --manifest-path monitor/Cargo.toml   # ratatui render tests (5)
```

Hub log: `~/.claude/hivemind/hub.log`. Socket path: `hivemind where`. Durable
state: `~/.claude/hivemind/group-*.json`.

## License

[PolyForm Noncommercial 1.0.0](LICENSE). Free to use, modify, and share for any
**noncommercial** purpose, with attribution (`Required Notice: Copyright (c) 2026
DatanoiseTV`). Commercial use requires a separate license — open an issue to ask.
