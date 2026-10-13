# Capped: tray app

Free, open-source (MIT) menu bar / tray app for macOS, Windows and Linux. It answers one question:
**how many dollars of API value does your AI plan's bar actually buy, this reset?**

- Reads token counts your tools already keep on disk (Claude Code, Codex) and Cursor's usage CSV you drop in.
- Prices them at public API list rates and divides by the vendor's own bar % → "$X of API value this week".
- Shows your 5h + weekly bars, reset countdown, the crowd median for this week and last week as plain numbers (with reading counts and an "early estimate" label while most windows are still open).
- Sharing is **off by default**. When on, it sends numbers only; installing the app means you agree to what it sends (https://www.gotcapped.com/privacy).
- **Crowd numbers fetch (always on):** once at start and then hourly, the app downloads the public crowd medians from gotcapped.com (`GET /api/ingest/crowd`). It sends nothing about you, but like any web request it reveals your IP address to our server. The server uses IPs only for rate limiting and stores them only as salted hashes.

## One engine
All parsing, pricing, attribution and payload building lives in `../gotcapped-cli/src` (the `npx gotcapped`
CLI). `engine/engine.ts` is a thin JSON front-end over those modules; it is bundled into a single-executable sidecar
(`gc-engine`) that the Rust core calls. Same `~/.gotcapped` state, same device ID, same `/api/ingest` contract as the CLI.

```
engine/      JSON front-end over the CLI engine (scan, sample, send, cursor, set-plan, install-hook, forget)
ui/          popover (plain HTML/CSS/JS, no remote code, strict CSP)
src-tauri/   Rust core: tray + monochrome mark icon, background loop, sign-in file watcher, settings, sending
fixtures/    synthetic home dir (canary strings) for tests and screenshots
test/        engine + privacy tests
docs/        SIGNING.md, SERVER_TODO.md
```

## What is sent (only if you opt in)
Per reset window: plan, vendor, window kind, reset time (15-min rounded), bar % + source, token counts per model,
a one-way HMAC of the account ID (never the ID itself) and one-way hashes of request IDs (dedupe).
The on-device HMAC uses a public pepper so the same account matches across devices. It is recomputable by anyone who already knows the raw id. The server must re-hash it with a secret before storage. That step is not in this app, it is not deployed from this repo, and it adds nothing to the upload. See [docs/INGEST_REKEY.md](docs/INGEST_REKEY.md).
**Never:** prompts, replies, code, file or project names, session IDs, emails, raw account IDs, login tokens.
`test/engine.test.mjs` fails the build if any canary from the fixture logs reaches the payload.

## Which login is read
Claude: the login of the `claude` command-line tool, from `~/.claude.json` (or `$CLAUDE_CONFIG_DIR`). Codex: `~/.codex/auth.json`.
The popover names the login it reads. The Claude desktop app signs in separately and doesn't write a readable plan or usage
bar, so its usage is not measured; its sessions are left out of the CLI login's numbers instead of being counted against it.
If you sign in to a different account, tokens from before the change are not counted for the new one.

## Develop
```
npm i && npm test                      # engine + privacy tests
SEA_NODE=/path/to/official/node node scripts/build-engine.mjs   # Debian's node lacks the SEA fuse
cd src-tauri && cargo test && npx tauri dev
GC_FIXTURE_HOME=/tmp/gc-fixture-home GC_SHOW=1 ./target/release/gotcapped-tray   # fixture mode (banner shown)
```
Not affiliated with Anthropic, OpenAI, Anysphere or Google.
