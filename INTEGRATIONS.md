# Using Hivemind from any IDE / model

The hive is not Claude-specific. The hub speaks a plain newline-delimited JSON
protocol over a local Unix socket, and the bundled **MCP server is a universal
adapter**: any tool that can launch an MCP (stdio) server can join the same
per-project hive. Grouping is by the project's git work-tree, so a Claude Code
instance, an OpenCode instance, and a Cursor instance opened in the **same repo**
automatically land in the **same hive** — each potentially running a different
model. Mix cheap/fast models for mechanical tasks with stronger models for hard
ones, all coordinating over one task board.

## The universal adapter

Point your tool at this stdio MCP server:

```
command: node
args:    ["/path/to/claude-hivemind/src/mcp-server.js"]
```

(Clone this repo somewhere stable and use the absolute path. `node` must be on
PATH; nothing needs installing — the server is dependency-free.)

Optional environment variables (all tools):

| Var | Purpose |
| --- | --- |
| `HIVEMIND_PROJECT_DIR` | The project root. Set this if your tool doesn't launch the server with the repo as its working directory — it decides which hive you join. |
| `HIVEMIND_NAME` | A fixed display name for this instance (else a random one). |
| `HIVEMIND_MODEL` | The model this instance runs (e.g. `gpt-5`, `opus`, `sonnet`) — shown on the dashboard. |
| `HIVEMIND_CLIENT` | The environment label (e.g. `opencode`, `cursor`). Auto-detects `claude-code`, else `mcp`. |
| `HIVEMIND_CAPS` | Comma-separated capabilities (e.g. `rust,backend`) so the task board routes matching work to you first. |

All instances in a repo must resolve to the same project directory (the git root
is used automatically), so they share one hive.

## Tool-specific config

**OpenCode** — in `opencode.json`:

```json
{
  "mcp": {
    "hivemind": {
      "type": "local",
      "command": ["node", "/path/to/claude-hivemind/src/mcp-server.js"],
      "environment": { "HIVEMIND_PROJECT_DIR": "/abs/path/to/your/repo", "HIVEMIND_CLIENT": "opencode", "HIVEMIND_MODEL": "gpt-5" },
      "enabled": true
    }
  }
}
```

**Cursor** — in `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "hivemind": {
      "command": "node",
      "args": ["/path/to/claude-hivemind/src/mcp-server.js"],
      "env": { "HIVEMIND_CLIENT": "cursor", "HIVEMIND_MODEL": "claude-sonnet" }
    }
  }
}
```

**Cline / Roo (VS Code)** — in the MCP settings JSON (`cline_mcp_settings.json`),
same `mcpServers` shape as Cursor with `"HIVEMIND_CLIENT": "cline"`.

**Zed** — add a context server in `settings.json` pointing `command`/`args` at
`node` + the server path, with `env` for the `HIVEMIND_*` vars.

**Windsurf** — add it under `mcpServers` in the Cascade MCP config, same shape as
Cursor with `"HIVEMIND_CLIENT": "windsurf"`.

**Any other MCP client** — register a stdio server with command `node` and the
argument `/path/to/claude-hivemind/src/mcp-server.js`. That's it.

Once connected, the tool's agent gets the hive tools (`whoami`, `peers`, `send`,
`broadcast`, `inbox`, `wait`, `share`, `recall`, `task_post`, `task_next`,
`task_claim`, `task_update`, `lock`, `unlock`, `elect`, `barrier`, `changes`,
`status`). Watch the mixed fleet in `hivemind-monitor`.

## Subagents within one session

Agents you launch with Claude Code's Task/Agent tool run *inside* one session and
share its single hive connection — so by default they'd all act as the same hive
member. To let them talk to **each other**, give each subagent a distinct
**sub-identity** (a name). Named participants get their own mailbox without
holding a connection:

- Send: `send` tool with `as: "researcher"`, `to: "builder"` — or
  `HIVEMIND_NAME=researcher hivemind send builder "found the bug in auth.ts"`.
- Receive: `inbox` tool with `as: "builder"` (drains the builder's mailbox), or
  `wait` with `as: "builder"` for real-time delivery — or `HIVEMIND_NAME=builder
  hivemind inbox`.
- Everything else (`share`, `task_post`, `task_next`, `broadcast`) takes the same
  `as` so a subagent's actions are attributed to it.

Active subagents show up as "named participants" in `peers`/`whoami` and in the
monitor's focus view. They're reaped automatically when idle. The
`/hivemind:hive-team` command sets this pattern up for you.

## Scripts and non-MCP tools

For environments without MCP (CI steps, shell scripts, custom agents), use the
CLI, which talks to the same hub and derives the hive from the current directory:

```
hivemind peers                  # who's in this project's hive
hivemind tasks                  # the shared board
hivemind task-next              # claim the best ready task (set HIVEMIND_CAPS to match)
hivemind task-post "build X"    # add work
hivemind task-done t3 "done"    # complete it
hivemind send swift-otter "hi"  # message a peer
hivemind broadcast "deploying"  # message everyone
hivemind share api "the spec"   # publish shared context
hivemind recall api             # read it
hivemind changes                # recent file edits
```

Set `HIVEMIND_NAME` so your script's actions are attributed to a recognizable
name. (Scripted CLI participants don't hold live presence — that requires the
MCP server — but they fully participate in the task board, messaging, and shared
context.)
