// Builds a FAKE home dir with synthetic Claude Code + Codex logs for tests and FIXTURE screenshots.
// Every number here is made up. Content fields contain canary strings that must never reach the payload.
import { mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
const H = process.argv[2] || "/tmp/gc-fixture-home"; rmSync(H, { recursive: true, force: true });
const now = Date.now(), iso = (t) => new Date(t).toISOString(), h = 36e5;
const weekReset = now + 3 * 24 * h + 4 * h, fiveReset = now + 2 * h + 13 * 6e4;
// Claude: ~/.claude.json account + session logs over the last 3 days (Opus/Sonnet mix).
mkdirSync(join(H, ".claude/projects/-Users-ali-secret-repo"), { recursive: true });
writeFileSync(join(H, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "fixture-uuid-A", organizationUuid: "fixture-org-A", emailAddress: "canary-email@example.com", organizationType: "claude_max", userRateLimitTier: "default_claude_max_20x" } }));
const lines = [];
for (let i = 0; i < 260; i++) {
  const t = now - 3 * 24 * h + i * 15 * 6e4; const opus = i % 4 !== 0;
  lines.push(JSON.stringify({ type: "user", timestamp: iso(t - 1000), message: { role: "user", content: "CANARY_PROMPT do not leak" } }));
  lines.push(JSON.stringify({ type: "assistant", timestamp: iso(t), requestId: "req_" + i, sessionId: "CANARY_SESSION", cwd: "/Users/dev/CANARY_PATH", message: { id: "msg_" + i, model: opus ? "claude-opus-5" : "claude-sonnet-5", content: [{ type: "text", text: "CANARY_OUTPUT" }], usage: { input_tokens: 1200, output_tokens: 3800, cache_read_input_tokens: 210000, cache_creation_input_tokens: 9000, cache_creation: { ephemeral_1h_input_tokens: 3000 } } } }));
}
writeFileSync(join(H, ".claude/projects/-Users-ali-secret-repo/CANARY_SESSION.jsonl"), lines.join("\n") + "\n");
// Statusline hook output (what `gotcapped hook statusline` appends).
const { createHmac } = await import("crypto");
const acct = createHmac("sha256", "gotcapped-pepper-v1").update("acct:claude:fixture-uuid-A:fixture-org-A").digest("hex").slice(0, 32);
mkdirSync(join(H, ".gotcapped"), { recursive: true });
const dir = join(H, ".claude");
writeFileSync(join(H, ".gotcapped/bars.jsonl"), [
  { t: now - 6e4, account: acct, dir, kind: "weekly", pct: 41, reset: weekReset, source: "statusline" },
  { t: now - 6e4, account: acct, dir, kind: "5h", pct: 63, reset: fiveReset, source: "statusline" },
].map((x) => JSON.stringify(x)).join("\n") + "\n");
writeFileSync(join(H, ".gotcapped/state.json"), JSON.stringify({ device: "f1f7a4e0000000000000000000000000", timeline: [{ t: now - 4 * 24 * h, vendor: "claude", dir, account: acct }], plans: {}, manual: [], autoSend: false }));
writeFileSync(join(H, ".gotcapped/tray-crowd.json"), JSON.stringify({ "claude-max-20x|weekly": { median: 160, n: 7, need: 0, early: true, prevMedian: 205, prevN: 6 }, "chatgpt-pro-200|weekly": { median: null, n: 3, need: 2 } }));
// Codex: auth.json with a fake id_token, plus one rollout with token_count + rate_limits.
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
mkdirSync(join(H, ".codex/sessions/2026/10/13"), { recursive: true });
writeFileSync(join(H, ".codex/auth.json"), JSON.stringify({ tokens: { account_id: "fixture-codex-acct", id_token: `x.${b64({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "fixture-codex-acct" }, email: "canary-email@example.com" })}.y`, access_token: "CANARY_TOKEN" } }));
const r = [JSON.stringify({ timestamp: iso(now - 30 * h), type: "session_meta", payload: { id: "CANARY_CODEX_SESSION", cwd: "/Users/dev/CANARY_PATH" } }), JSON.stringify({ timestamp: iso(now - 30 * h), type: "turn_context", payload: { model: "gpt-6.1-sol", cwd: "/Users/dev/CANARY_PATH" } })];
let tot = 0;
for (let i = 0; i < 120; i++) {
  const t = now - 30 * h + i * 14 * 6e4, u = { input_tokens: 190000, cached_input_tokens: 172000, output_tokens: 5200, total_tokens: 195200 }; tot += u.total_tokens;
  r.push(JSON.stringify({ timestamp: iso(t), type: "response_item", payload: { type: "message", content: [{ text: "CANARY_OUTPUT" }] } }));
  r.push(JSON.stringify({ timestamp: iso(t), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: tot }, last_token_usage: u }, rate_limits: { primary: { used_percent: 22, window_minutes: 300, resets_at: Math.round((now + 3 * h) / 1000) }, secondary: { used_percent: 18, window_minutes: 10080, resets_at: Math.round((now + 5 * 24 * h) / 1000) } } } }));
}
writeFileSync(join(H, ".codex/sessions/2026/10/13/rollout-fixture.jsonl"), r.join("\n") + "\n");
// Cursor usage CSV (as exported from the dashboard).
writeFileSync(join(H, "cursor-usage-fixture.csv"), ["Date,Kind,Model,Max Mode,Input (w/ Cache Write),Input (w/o Cache Write),Cache Read,Output,Total Tokens,Cost", ...Array.from({ length: 40 }, (_, i) => `${iso(now - i * 9 * h)},Included,claude-sonnet-4.5,No,52000,48000,410000,6100,468100,0.42`)].join("\n"));
console.log(H);
