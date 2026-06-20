---
description: Sync with peers — announce your intent and gather theirs before proceeding
argument-hint: [what you are about to do]
---

Coordinate with the hive before proceeding.

1. `broadcast` your intent: "$ARGUMENTS" (if empty, summarize what you are currently doing).
2. Drain your `inbox` to read anything peers already sent you.
3. Call `wait` (with `want: ["message"]`, ~20s) once to give peers a chance to respond, claim parts, or flag conflicts.
4. Reconcile: if a peer is doing overlapping work, adjust — claim a different task, or `lock` the files you need. Summarize the agreed division of labour for me.
