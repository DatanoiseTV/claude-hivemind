# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres
to [Semantic Versioning](https://semver.org/).

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
