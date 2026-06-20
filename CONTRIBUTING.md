# Contributing to Hivemind

Thanks for your interest. This project is built to a high bar: correctness is
measured, not assumed, and changes ship with tests.

## Layout

- `src/hub.js` — the coordination daemon (in-memory state, NDJSON over a Unix socket).
- `src/mcp-server.js` — the per-instance MCP bridge that exposes the hive tools.
- `src/hooks/` — session orientation, per-turn digest, edit guard, change feed.
- `src/lib/` — shared protocol, client, and helpers (dependency-free Node).
- `src/cli.js`, `bin/hivemind` — human CLI.
- `monitor/` — the Rust + ratatui dashboard.
- `test/` — Node integration, MCP smoke, durability, and throughput benchmark.
- `commands/`, `hooks/hooks.json`, `.mcp.json`, `.claude-plugin/` — plugin wiring.

## Running the tests

```
npm test                                          # engine + MCP + durability
npm run bench                                      # throughput / latency
cargo test --manifest-path monitor/Cargo.toml      # ratatui render tests
cargo clippy --manifest-path monitor/Cargo.toml -- -D warnings
```

The Node core is dependency-free on purpose — please keep it that way (Node
built-ins only) so the plugin runs with no install step. The monitor may use
crates.

## Pull requests

- One concern per PR. Add or update tests in the same change.
- Run the full suite (and `cargo clippy`) before pushing; CI gates on both.
- Match the surrounding style; document the *why* in comments and commit bodies.
- Keep the protocol backward-compatible, or call out the break explicitly.

## License of contributions

By contributing you agree your contributions are licensed under the project's
[PolyForm Noncommercial 1.0.0](LICENSE) license.
