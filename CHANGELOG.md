# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/).

## [0.7.0] — 2026-06-25

### Added

- **The task board now fills itself.** A `PostToolUse` hook on
  `TaskCreate|TaskUpdate|TaskList` mirrors each instance's native task/todo list
  onto the hive board automatically — so the board reflects what everyone is
  actually planning and doing, with no new habit to learn and no token cost.
  Mirrored tasks are owned by their session, shown for awareness but never
  claimable as shared work, reconciled from list snapshots, and cleared when the
  session ends. They appear dimmed with a `~` and as a `~N plans` count in the
  monitor, kept separate from the claimable work-stealing queue.
- **`/hivemind:hive-orchestrate <goal>`** — run an iterative, multi-phase effort
  as the "head" of the hive: claim the head role, frame the goal, delegate
  planning, decompose into a phased task graph (deps + tags), recruit workers or
  subagents, review, synthesize, and loop. Domain-agnostic — works for coding and
  non-coding goals alike.

## [0.6.0] — 2026-06-20

### Added

- **`dispatch` — actively drive another instance.** Type a prompt into another
  instance's terminal window and press Enter, so it runs a turn. Supports iTerm2
  sessions (macOS) and tmux panes. This is the deliberate exception to the
  otherwise no-auto-dispatch model, so it is gated hard:
  - **Opt-in target.** A window is only controllable if it was started with
    `HIVEMIND_ALLOW_DISPATCH=1` (which is what makes it register an input
    channel). It shows as `[dispatchable]` in `peers` and `⌨` in the monitor.
  - **Explicit action.** Nothing dispatches automatically; an agent or human
    invokes it on purpose. Refuses to dispatch to yourself.
  - It is real remote control: it spends the target's tokens and may make it take
    actions with no human typing on that side. Use deliberately, not in loops.
  - Exposed as the `dispatch` MCP tool and `hivemind dispatch <to> <prompt>`. On
    macOS, the first dispatch prompts once for Automation permission to control
    iTerm.

## [0.5.1] — 2026-06-20

### Fixed

- **Idle instances now auto-rejoin after a hub restart.** Previously a persistent
  client cleared its heartbeat on disconnect and only reconnected on the next
  hive tool call, so an idle session went missing from the hive (and its presence
  was lost) until the agent next used a hive tool. The client now keeps a
  lifetime ticker that reconnects and re-registers on its own within a heartbeat,
  so presence survives a hub restart even while idle.

## [0.5.0] — 2026-06-20

Subagents can collaborate with each other.

### Added

- **Named participants (mailboxes).** A lightweight identity that isn't tied to a
  socket, so multiple agents launched inside one Claude Code session (via the
  Task/Agent tool) can message each other as distinct peers. `send`, `broadcast`,
  `inbox`, and `wait` take an `as` field; a recipient name with no live connection
  gets its own mailbox it can drain or long-poll. Active participants show up in
  `peers`/`whoami` and the monitor's focus view, and are reaped when idle.
- **CLI `inbox`** command and `/hivemind:hive-team` command for orchestrating a
  team of coordinating subagents. INTEGRATIONS.md documents the pattern.

### Changed

- An explicit `as` now overrides the connection's identity for the actor name, so
  a subagent's actions are attributed to it across both the MCP tools and the CLI.

## [0.4.0] — 2026-06-20

Filesystem awareness, and an explicit no-auto-dispatch guarantee.

### Added

- **Filesystem watching.** The hub watches each active project for changes,
  debounced (a save-all/build/git-checkout collapses into one event) and filtered
  (ignores `node_modules`, `.git`, build output, logs, temp files). It dedups an
  agent's own edits, so the feed shows only **external** changes (a build, a git
  pull, you editing in another editor) — the genuinely useful signal. It **never
  invokes an LLM**: changes are recorded as passive state and surface in the
  per-turn digest and the `changes` tool, so awareness costs no tokens until a
  turn you already started. Disable with `HIVEMIND_WATCH=off`; extend the ignore
  list with `HIVEMIND_WATCH_IGNORE`.

### Changed

- **No auto-dispatch.** Nothing the hive does automatically rouses or prompts an
  instance. System events (joins/leaves) and filesystem changes are now passive
  (ambient feed only) — they never land in an inbox or wake a `wait`. Only an
  explicit peer `send`/`broadcast`, or a task becoming available to a worker that
  opted in via `wait`, can wake an instance. Idle instances are never prompted.

## [0.3.0] — 2026-06-20

Opened the hive to any IDE/model and made the dashboard come alive.

### Added

- **Cross-IDE / cross-model collaboration.** The MCP server is a universal
  adapter: OpenCode, Cursor, Cline, Zed, Windsurf — any MCP-capable tool — can
  join the same per-project hive as Claude Code, each running a different model.
  Project-dir resolution is IDE-agnostic (`HIVEMIND_PROJECT_DIR` override). Each
  instance carries its environment (`HIVEMIND_CLIENT`) and model
  (`HIVEMIND_MODEL`), shown on presence and the dashboard. See
  [INTEGRATIONS.md](INTEGRATIONS.md).
- **CLI coordination ops** so non-MCP environments and scripts can participate in
  the task board, messaging, and shared context: `hivemind peers | tasks |
  task-next | task-post | task-done | send | broadcast | share | recall |
  changes`. One-shot actors name themselves via `as`.
- **Animated, futuristic monitor** (~10 fps): pulsing neon header with a live
  spinner, a spinner on every instance currently working, softly pulsing presence
  dots, a pulsing selection border, and cards that flash cyan the instant their
  hive does anything. Instance lines show the environment/model so a mixed fleet
  is legible at a glance.

## [0.2.0] — 2026-06-20

Made the hive smarter, more self-aware, and durable.

### Added

- **Dependency-aware task board.** Tasks can declare `deps`, `priority`, and
  `tags`. The board computes which tasks are *ready* (all dependencies done);
  workers only ever claim ready work, so phases serialize while independent work
  runs in parallel. Completing a task automatically unblocks its dependents.
- **Smart claim (`task_next`).** One atomic call grabs the best ready task for an
  instance — highest priority, capability-matched, oldest first. `task_claim`
  with no id behaves the same. The worker loop is now a single primitive.
- **Capability routing.** Instances advertise capabilities (`HIVEMIND_CAPS` or
  per-call), and tagged tasks are routed to matching instances first.
- **Auto-presence.** Claiming a task sets what an instance is "working on";
  finishing clears it. Visible to peers (`whoami`/`peers`) and the dashboard.
- **Turn-activity signal.** The prompt hook pulses a `turn` to the hive, so an
  instance that is actively being used shows up on the dashboard even when it
  isn't messaging or editing — fixing the "everything reads 0 while busy" gap.
- **Durability.** The task board and shared-context blackboard are snapshotted
  to disk (async, atomic) and restored on hub restart; in-flight work reopens so
  a fresh fleet resumes it. Presence, messages, and locks remain ephemeral.
- **Monitor focus view.** Press Enter on a hive for a full-screen detail: every
  instance (with capabilities + current task), the whole board with ready/blocked
  state and dependencies, the activity feed, and recent file edits. The activity
  sparkline now includes turns.

### Changed

- Persistence writes are async + atomic so disk I/O never stalls the message
  loop. Measured sustained throughput: ~150k msgs/sec, ~0.04 ms median round-trip
  on local IPC (`npm run bench`).

## [0.1.0] — 2026-06-20

Initial release.

### Added

- **Hub daemon** (`src/hub.js`): a single per-user background process that holds
  all shared hive state in memory, partitioned by project group. Lazily started,
  auto-reaps disconnected instances, idle-shuts-down after 60 minutes.
- **MCP server** (`src/mcp-server.js`): bridges each Claude Code instance to the
  hub and exposes the hive toolset (`whoami`, `peers`, `send`, `broadcast`,
  `inbox`, `wait`, `share`, `recall`, `task_post`/`task_list`/`task_claim`/
  `task_update`, `lock`/`unlock`, `elect`/`release_role`, `barrier`, `changes`,
  `status`).
- **Project grouping**: instances are grouped by git work-tree root (falling
  back to cwd), so collaboration is isolated per project.
- **Coordination primitives**: presence, direct + broadcast messaging with a
  long-poll `wait`, a shared-context blackboard, a work-stealing task board with
  atomic claim, advisory locks, leader election, and lockstep barriers.
- **Hooks**: session orientation, per-turn peer-activity digest, advisory
  cross-instance edit-collision guard (`ask` on a real conflict), and a shared
  repo-change feed.
- **Slash commands**: `/hivemind:hive`, `hive-status`, `hive-plan`,
  `hive-worker`, `hive-sync`, `hive-broadcast`, `hive-share`.
- **Monitor** (`monitor/`): a Rust + ratatui dashboard showing every active
  project hive at once with live message/edit sparklines, task-progress gauges,
  per-hive feeds, stats, and an operator-broadcast input.
- **CLI** (`src/cli.js`): no-build `status` / `watch` / `groups` / `stop` /
  `where`, plus a `hivemind` launcher on PATH.
- **Tests**: Node engine integration test (20 checks), MCP stdio smoke test
  (9 checks), and headless ratatui render tests (3 checks).
