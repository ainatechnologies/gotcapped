# gotcapped

**How much API value does your AI plan's usage bar actually buy?**

`gotcapped` reads the token counts your Claude Code and Codex CLI already log on your machine, prices them at public API list prices, and divides by the % of the bar that work used. That gives one number per plan per reset window:

> This week your Claude Max 20x gave **$412** of API value so far. Bar at 44% → about **$936 per full bar**.

If you opt in, it shares *only those numbers* with [gotcapped.com](https://www.gotcapped.com), where they become crowd medians per plan per reset week, so everyone can see whether this week's bar is worth the same as last week's.

```sh
npx gotcapped            # measure, show exactly what would be sent, ask before sending
npx gotcapped --dry-run  # measure and preview only, never sends
```

Node 18+. macOS, Linux and Windows. No dependencies.

## What it supports (v0.1)

| Tool | Tokens | Bar % |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl`, `~/.config/claude/projects`, `$CLAUDE_CONFIG_DIR` | Status-line hook (Claude Code passes `rate_limits` to the status line). Run `gotcapped install-hook` once. Without it you're asked once for the % shown in `/usage`. |
| Codex CLI | `$CODEX_HOME/sessions/**/rollout-*.jsonl` (+ `archived_sessions`) | `codex app-server` → `account/rateLimits/read` (local, via your installed Codex), else `rate_limits` in the rollout logs, else asked once. |

Cursor, Gemini CLI and a tray app are next. See the spec in the repo.

## Commands

```
npx gotcapped                 measure + preview + confirm
npx gotcapped --watch         re-send hourly (asks once; --yes to skip the question)
npx gotcapped install-hook    add the Claude Code status-line hook (automatic bar %)
npx gotcapped pause           stop automatic sending
npx gotcapped forget          delete all local tracker state (~/.gotcapped)
Options: --yes --json --full --no-prompt --plan claude=claude-max-20x,codex=chatgpt-pro-200 --endpoint URL
```

For the hook, install globally first so the status line doesn't go through npx each time: `npm i -g gotcapped && gotcapped install-hook`. If you already have a status line, it keeps working (ours runs first, then hands stdin to yours with `--then`). A backup of `settings.json` is written next to it.

## Privacy

**Nothing leaves your machine unless you say yes.** Every run prints the exact JSON first, and the full payload is saved to `~/.gotcapped/outbox/last.json` so you can check it.

What the tracker **reads** (allow-listed fields only):
- Claude Code log lines: `timestamp`, `requestId`, `message.id`, `message.model`, `message.usage.*`. Message content is never read into the tracker's data.
- Codex rollouts: `token_count` events, the model name from `turn_context`, the session id from `session_meta` (only to build a hash), and `rate_limits`.
- Account identity: `~/.claude.json` → `oauthAccount.accountUuid` / `organizationUuid` / plan tier; `~/.codex/auth.json` → `account_id` and the plan type claim. Tokens and secrets in those files are never used or sent.

What it **sends**, per account and reset window: vendor, plan, a hashed account key, seat type, window kind and reset time (rounded to 15 min), bar % with the time it was read, the window's start and end, tokens per model (input / output / cache read / cache write, plus `lc`: how many requests crossed the model's long-context price threshold), one-way 16-character hashes of request IDs so the same logs aren't counted twice, and `proof` (the SHA-256 of your device secret, used to verify deletion).

What it **never sends**: prompts, responses, code, file or project paths, session IDs, git branches, emails, names, raw account or org IDs, or raw request IDs. A test fails the build if any other key or any of those strings reaches the payload.

**Hashing.** Account keys are `HMAC-SHA256("gotcapped-pepper-v1", vendor:accountId:orgId)` computed on your device. The pepper is public on purpose, so the same account hashes the same on your laptop and desktop and the two can be merged instead of counted twice. Account IDs are random UUIDs, so the hash can't be reversed by guessing.

**Device ID.** A random 128-bit ID made on first run (never derived from hardware). Stored in `~/.gotcapped/state.json`.

**Deleting your data.** `npx gotcapped forget` deletes every reading this device sent, then the local state. On first run the tracker makes a random 256-bit device secret. Uploads carry only its SHA-256 (`proof`), and the server pins that hash to your device ID. Deletion needs the secret itself, so nobody else can delete or overwrite your data, even if they learn your device ID. If the server call fails, your local state is kept so you can retry (`--local-only` deletes it anyway).

**Server side.** IPs are used only for rate limiting and stored only as salted hashes. Plan pages show aggregates only, and medians appear at 5+ readings.

## Several accounts? (switching when one caps)

$ per bar is computed **per account and per window, never summed across accounts**. The tracker keeps a local timeline of which account was active in each config dir. It samples on every status-line refresh, every run, and every minute in `--watch`. Each token entry goes to the account active at that moment. Entries near a switch (±60 s), or between samples of two different accounts, are dropped. A window where over 10% of tokens are ambiguous doesn't count. History from before the tracker first ran is marked `inferred` and counts at 0.7 weight, and only when that dir has only ever shown one account.

## How the number is computed

`$ per full bar = Σ tokens × public API list price ÷ (bar % / 100)`, for one account in one reset window. The server re-prices everything from raw token counts with its versioned price table. The $ shown locally is for display. Bars under 10% are too coarse to scale up and don't count. From 10% to 25% the weight ramps linearly from 0 to full. A still-open window counts as an early estimate, and its final reading replaces it once the window closes. This week vs last week is shown as plain numbers, using closed windows only. Requests above a model's long-context threshold are counted on your device (only the count is sent, as `lc`), and those readings are marked as a floor. Claude 1-hour cache writes are priced at 2× input, and 5-minute writes at 1.25×.

## Credits

Parsing ideas from [ccusage](https://github.com/ryoppippi/ccusage), [CodexBar](https://github.com/steipete/CodexBar) and [tokscale](https://github.com/junhoyeo/tokscale), all MIT. Built from the documented formats, with no code copied.

## License

MIT © AINA Technologies
