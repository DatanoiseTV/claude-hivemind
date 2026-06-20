---
description: Publish shared context to the hive blackboard for all instances
argument-hint: <key> :: <context to share>
---

Parse "$ARGUMENTS" as `<key> :: <content>`.

Publish it to the hive with the `share` tool (key = text before `::`, value = text after, plus a one-line summary). If there is no `::`, pick a sensible short key yourself and tell me what you chose.

Then list the current shared-context keys with `recall` (no key) so I can see the hive's shared knowledge.
