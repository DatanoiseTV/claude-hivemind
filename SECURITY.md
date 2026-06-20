# Security

## Threat model

Hivemind is a **local, single-user** coordination fabric. The hub listens only
on a Unix domain socket under a per-user runtime directory (directory mode
`0700`, socket mode `0600`); on Windows it uses a per-user named pipe. Nothing
is exposed on the network — there is no TCP listener and no remote access.

- State is partitioned by project group; instances in different projects cannot
  see each other's messages, tasks, or shared context.
- Durable state (the task board and shared-context blackboard) is written to
  `~/.claude/hivemind/group-*.json` with mode `0600`. Do not put secrets in
  shared context if your home directory is shared.
- The hub trusts any local process that can reach the socket (i.e. any process
  running as your user). It is not a security boundary between processes of the
  same user.

## Reporting a vulnerability

Please open a private security advisory on GitHub
(`Security` → `Report a vulnerability`) rather than a public issue. Include a
reproduction and the impact. You will get an acknowledgement within a few days.
