---
description: Print the full hive status — peers, task board, shared context, locks
---

Call the hive `status` tool and present the result clearly:

- Connected instances and what each is doing.
- The task board, grouped by status (open / claimed / in_progress / done / failed).
- Shared-context keys (from `recall` with no key) and any active locks or elected roles.

Then call the hive `changes` tool and list recent file edits across the hive. Keep it concise.
