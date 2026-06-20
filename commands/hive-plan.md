---
description: Split a goal into parallel tasks and post them to the hive task board
argument-hint: <goal to divide among the hive>
---

Goal: $ARGUMENTS

Break this goal into independent, parallelizable units of work that several Claude instances can execute concurrently without stepping on each other.

For each unit:
- Make it self-contained, and note which files it will touch (so workers can `lock` them).
- Give it a clear title and concrete acceptance criteria.
- Identify ordering: which units depend on which. Independent units should run in parallel.

Then:
1. Post each unit to the shared board with the hive `task_post` tool. Use `deps` to encode ordering (a task only becomes claimable once its prerequisites are `done`), `priority` to surface the critical path first, and `tags` (e.g. `["frontend"]`, `["rust"]`) so capability-matched instances pick up the right work. Post foundational tasks first so later ones can reference their ids in `deps`.
2. Publish any context every worker needs (the plan, conventions, key decisions) with the hive `share` tool under clear keys.
3. `broadcast` to peers that the board is populated and they can run `/hivemind:hive-worker` to help.
4. Show me the resulting board with `task_list`.

Lay out the plan for the hive first — do not start executing the tasks yourself unless I ask.
