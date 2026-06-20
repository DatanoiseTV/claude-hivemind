---
description: Spawn subagents that coordinate with each other through the hive
argument-hint: <goal to tackle with a coordinated subagent team>
---

Goal: $ARGUMENTS

Tackle this by launching a team of subagents that collaborate through the hive in
real time, instead of working blind and only reporting back to you.

Subagents you spawn share this session's single hive connection, so each one must
use a **distinct sub-identity** to be addressable. Give every subagent a short
hive name and tell it, in its prompt, to coordinate using that name:

- To message a teammate: the `send` hive tool with `as: "<my-name>"` and
  `to: "<teammate-name>"` — or, via Bash, `HIVEMIND_NAME=<my-name> hivemind send
  <teammate-name> "<message>"`.
- To check its own messages: the `inbox` tool with `as: "<my-name>"` (or
  `HIVEMIND_NAME=<my-name> hivemind inbox`), or block on `wait` with
  `as: "<my-name>"` to receive in real time.
- To share results the whole team needs: `share` / `broadcast` (pass
  `as: "<my-name>"`), and the shared task board (`task_post` / `task_next`).

Plan it:
1. Decompose the goal into roles (e.g. `researcher`, `builder`, `reviewer`) and
   name each subagent.
2. If there are dependencies, post them to the board with `task_post` deps so the
   right work unblocks in order.
3. Spawn the subagents in parallel, each prompted with its hive name, its job, who
   its teammates are, and the instruction to coordinate via the hive (hand off
   intermediate results with `send`/`share` rather than waiting until the end).
4. Track progress with the `status` / `peers` tools (subagents appear as named
   participants) and reconcile their results for me.
