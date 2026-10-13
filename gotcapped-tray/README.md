# Got Capped: tray app

Free, open-source (MIT) menu bar / tray app for macOS, Windows and Linux. It answers one question:
**how many dollars of API value does your AI plan's bar actually buy, this reset?**

- Reads token counts your tools already keep on disk (Claude Code, Codex) and Cursor's usage CSV you drop in.
- Prices them at public API list rates and divides by the vendor's own bar % → "$X of API value this week".
- Shows your 5h + weekly bars, reset countdown, the crowd median for this week and last week as plain numbers (with reading counts and an "early estimate" label while most windows are still open).
- Sharing is **off by default**. When on, it sends numbers only. You can see the exact payload first.
- **Crowd numbers fetch (always on):** once at start and then hourly, the app downloads the public crowd medians from gotcapped.com (`GET /api/ingest/crowd`). It sends nothing about you, but like any web request it reveals your IP address to our server. The server uses IPs only for rate limiting and stores them only as salted hashes.

## One engine
All parsing, pricing, multi-account attribution and payload building lives in `../gotcapped-cli/src` (the `npx gotcapped`
CLI). `engine/engine.ts` is a thin JSON front-end over those modules; it is bundled into a single-executable sidecar
(`gc-engine`) that the Rust core calls. Same `~/.gotcapped` state, same device ID, same `/api/ingest` contract as the CLI.

```
engine/      JSON front-end over the CLI engine (scan, sample, send, cursor, set-plan, install-hook, forget)
ui/          popover (plain HTML/CSS/JS, no remote code, strict CSP)
src-tauri/   Rust core: tray + gauge icon, background loop, account-switch file watcher, settings, sending
fixtures/    synthetic home dir (canary strings) for tests and screenshots
test/        engine + privacy tests
docs/        SIGNING.md, SERVER_TODO.md
```

## What is sent (only if you opt in)
Per account-window: plan, vendor, window kind, reset time (15-min rounded), bar % + source, token counts per model,
a one-way HMAC of the account (so account switching never mixes numbers) and one-way hashes of request IDs (dedupe).
**Never:** prompts, replies, code, file or project names, session IDs, emails, raw account IDs, login tokens.
`test/engine.test.mjs` fails the build if any canary from the fixture logs reaches the payload.

## Multi-account (§17)
The Rust core watches `~/.claude.json`, `~/.claude/.credentials.json`, `~/.codex/auth.json` (and `$CLAUDE_CONFIG_DIR`,
`$CODEX_HOME`). Any change triggers an account sample; the engine also samples every minute. Each token is attributed
to the account active at that time; ±60 s around a switch is dropped. $/bar is per account-window, never summed.

## Develop
```
npm i && npm test                      # engine + privacy tests
SEA_NODE=/path/to/official/node node scripts/build-engine.mjs   # Debian's node lacks the SEA fuse
cd src-tauri && cargo test && npx tauri dev
GC_FIXTURE_HOME=/tmp/gc-fixture-home GC_SHOW=1 ./target/release/gotcapped-tray   # fixture mode (banner shown)
```
Not affiliated with Anthropic, OpenAI, Anysphere or Google.
