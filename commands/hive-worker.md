---
description: Join the hive as a worker — claim and execute tasks until the board is empty
---

Act as a hive worker. Repeat this loop:

1. Call the hive `task_list` tool. If there is an `open` task, claim one with `task_claim`. If the claim fails (a peer won it), try the next open task.
2. If there are no open tasks, call the hive `wait` tool with `want: ["task"]` and a 60s timeout to block until work appears. If it times out and the board is still empty, stop and tell me there is no more work.
3. Read any shared context you need with `recall`. Before editing files the task requires, `lock` them (and check `changes`) to avoid collisions; `unlock` when done.
4. Do the task fully and correctly — write the code, run the tests. Publish results other tasks depend on with `share`.
5. Update the task with `task_update` (`in_progress`, then `done` with a short result note, or `failed` with the reason).
6. Go back to step 1.

Give me a one-line update each time you claim or finish a task.
