# AaaS-Love fork of billion-context (local-only build)

Fork of https://github.com/ranxianglei/billion-context (MIT, Copyright (c) 2026 ranxianglei; the
upstream LICENSE adds an attribution term, kept unchanged in `LICENSE`).

**Attribution:** this build uses billion-context and acp-kernel by ranxianglei —
https://github.com/ranxianglei/billion-context and https://github.com/ranxianglei/acp-kernel.

## What this build does and does not do

The only network traffic is the model request the proxy forwards to the upstream you configured
(`ACP_UPSTREAM` / `billion-context.json`). Everything else was cut:

| Removed / disabled | How |
| --- | --- |
| Auto-update from npm, forced installs, forced rollbacks | fetch site refuses (`src/no-egress.ts`), watcher never starts, `autoUpdate` forced `false` |
| Advisory package / advisory feed (could force-install versions) | fetch refuses, watcher never starts, `advisoryCheck` forced `false` |
| Remote announcements, release notes, update policy, changelog, blog refresh | fetch refuses / early return |
| models.dev catalog refresh | early return; the bundled snapshot is used |
| Download of native sqlite engine tarballs | refuses; use Node >= 22.5 (builtin `node:sqlite`) |
| TLS interception (local CA, `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`, CONNECT handling) | `setupMitm` call deleted, `mitm.enabled` forced `false` |
| Commands that rewrite client configs/hooks or launch clients: `plugin`, `plugin-register`, `mcp`, `pack`, `update`, `launch` (`bili claude`, `bili pi`, ...), `test` | exit 2 with a message |
| Bind to anything but loopback | `assertLoopbackBind` in `loadOptions` and before `listen`; `--host 0.0.0.0` fails |

Not touched: Claude Code managed settings, any security or trust setting. This build never writes
into a client's configuration.

## Use

```bash
node dist/index.js start            # binds 127.0.0.1:8787 by default (ACP_PORT to change)
```

Point the client at `http://127.0.0.1:<port>` (for Claude Code: `ANTHROPIC_BASE_URL`). The upstream
API key stays in the client; the proxy forwards it to the configured upstream only.

Verify: `node --import ./tests/preload-test-env.mjs --import tsx --test tests/aaas-local-only.test.ts`
starts the proxy against a fake upstream, records every socket connect, DNS lookup and spawned
process for 17 s and fails on anything that is not loopback.

## Data at rest

The proxy stores conversation content **in plaintext** on this machine (sessions, logs, caches).
Locations (XDG, see `src/paths.ts`; override with the `XDG_*` variables or `BILI_SESSIONS_DIR`,
`ACP_LOG_FILE`):

- `~/.config/billion-context/` — configuration
- `~/.local/share/billion-context/` — sessions (one JSON per session) and the sqlite store
- `~/.local/state/billion-context/` — log files
- `~/.cache/billion-context/` — caches

Protect them like the transcripts they contain (file mode `0700` on the directories; do not sync or
back them up to shared places). **Wipe:** stop the proxy, then delete the four directories above
(`rm -rf ~/.config/billion-context ~/.local/share/billion-context ~/.local/state/billion-context
~/.cache/billion-context`; on Windows the same paths under `%USERPROFILE%`). `bili storage` can
prune old sessions without deleting everything.

## Dependencies

Runtime dependencies and devDependencies in `package.json` are pinned to the exact versions of
`package-lock.json`; install with `npm ci --ignore-scripts`.
