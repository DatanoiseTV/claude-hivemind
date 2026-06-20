# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/).

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
