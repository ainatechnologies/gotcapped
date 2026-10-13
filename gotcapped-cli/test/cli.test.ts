import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, readdirSync } from "fs";
import { tmpdir, homedir } from "os";
import { join } from "path";
import { spawnSync } from "child_process";
import { parseClaudeLine, scanClaude, barsFromStatusline, claudeAccount } from "../src/claude";
import { parseRollout, barsFromRateLimits, codexAccount } from "../src/codex";
import { attributor } from "../src/attrib";
import { buildReading, latestBars, previewOf } from "../src/build";
import { accountKey } from "../src/util";
import { priceUsage } from "../src/shared/prices";

const FX = join(__dirname, "..", "..", "test", "fixtures");
const T = (s: string) => Date.parse(s);
const ACC_A = accountKey("claude", "uuid-A", "org-A"), ACC_B = accountKey("claude", "uuid-B", "org-B");

test("claude parser: usage fields only, 1h cache split, dedupe, synthetic skipped", () => {
  const d = mkdtempSync(join(tmpdir(), "gc-")); mkdirSync(join(d, "projects", "p"), { recursive: true });
  copyFileSync(join(FX, "claude-session.jsonl"), join(d, "projects", "p", "s.jsonl"));
  const es = scanClaude(d, 0);
  assert.equal(es.length, 2);
  assert.deepEqual({ ...es[0], req: undefined, t: undefined }, { t: undefined, req: undefined, m: "claude-opus-5", in: 10, out: 2000, cr: 100000, cw: 0, cw1h: 20000 });
  assert.equal(es[1].cw, 4000); assert.equal(es[1].cw1h, 0);
  assert.match(es[0].req, /^[0-9a-f]{16}$/);
  assert.equal(parseClaudeLine('{"type":"user","message":{"content":"x"}}'), null);
});

test("1-hour cache writes are priced at 2× input", () => {
  const a = priceUsage([{ m: "claude-opus-5", in: 0, out: 0, cr: 0, cw: 0, cw1h: 1e6 }]).usd;
  assert.equal(a, 10); // opus-5 input $5/M × 2
});

test("statusline: used_percentage + resets_at (epoch seconds and ISO)", () => {
  const b = barsFromStatusline({ rate_limits: { five_hour: { used_percentage: 41, resets_at: 1792000000 }, seven_day: { used_percentage: 63.5, resets_at: "2026-10-16T08:00:00Z" } } }, ACC_A, "/d", 1);
  assert.equal(b.length, 2); assert.equal(b[0].kind, "5h"); assert.equal(b[0].reset, 1792000000000); assert.equal(b[1].pct, 63.5);
  assert.deepEqual(barsFromStatusline({}, ACC_A, "/d"), []);
});

test("codex rollout: token deltas, cached split out of input, rate limits read", () => {
  const r = parseRollout(readFileSync(join(FX, "codex-rollout.jsonl"), "utf8"));
  assert.ok(r.entries.length > 0);
  const e = r.entries[0]; assert.equal(e.m, "gpt-6.1-sol"); assert.equal(e.in, 15000); assert.equal(e.cr, 165000); assert.equal(e.out, 4200);
  assert.ok(r.bars.some((b) => b.kind === "5h"));
  const rpc = barsFromRateLimits({ primary: { usedPercent: 12, windowDurationMins: 300, resetsAt: 1792000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080, resetsAt: 1792300000 } }, 5, "a", "/c", "rpc");
  assert.deepEqual(rpc.map((b) => b.kind), ["5h", "weekly"]);
  assert.equal(barsFromRateLimits({ primary: { usedPercent: 0, windowDurationMins: 43200, resetsAt: 1 } }, 5, "a", "/c", "rpc").length, 0); // monthly free-tier window: not a plan we track
});

test("multi-account: tokens go to the account active at that time; ±60 s of a switch is dropped", () => {
  const tl = [
    { t: T("2026-10-12T08:00:00Z"), vendor: "claude", dir: "/d", account: ACC_A },
    { t: T("2026-10-12T10:00:00Z"), vendor: "claude", dir: "/d", account: ACC_A },
    { t: T("2026-10-12T12:00:00Z"), vendor: "claude", dir: "/d", account: ACC_B },
    { t: T("2026-10-12T14:00:00Z"), vendor: "claude", dir: "/d", account: ACC_B },
  ];
  const who = attributor(tl, "claude", "/d");
  assert.equal(who(T("2026-10-12T09:00:00Z")).account, ACC_A);
  assert.equal(who(T("2026-10-12T11:00:00Z")).how, "ambiguous"); // between an A sample and a B sample
  assert.equal(who(T("2026-10-12T12:00:30Z")).how, "ambiguous"); // within 60 s of the switch
  assert.equal(who(T("2026-10-12T13:00:00Z")).account, ACC_B);
  assert.equal(who(T("2026-10-12T07:00:00Z")).how, "ambiguous"); // before first sample, but the dir has shown two accounts
  const one = attributor([tl[0]], "claude", "/d"); assert.deepEqual(one(T("2026-10-12T07:00:00Z")), { account: ACC_A, how: "inferred" });

  const mk = (t: string, out: number, req: string) => ({ t: T(t), m: "claude-opus-5", in: 0, out, cr: 0, cw: 0, cw1h: 0, req });
  const entries = [mk("2026-10-12T09:00:00Z", 1e6, "a1"), mk("2026-10-12T11:00:00Z", 5e5, "x1"), mk("2026-10-12T13:00:00Z", 2e6, "b1")];
  const bar = (account: string, pct: number) => ({ t: T("2026-10-12T14:00:00Z"), account, dir: "/d", kind: "weekly" as const, pct, reset: T("2026-10-16T08:00:00Z"), source: "statusline" as const });
  const a = buildReading({ vendor: "claude", plan: "claude-max-20x", bar: bar(ACC_A, 10), entries, timeline: tl });
  const b = buildReading({ vendor: "claude", plan: "claude-max-20x", bar: bar(ACC_B, 20), entries, timeline: tl });
  assert.equal(a.reading.usage[0].out, 1e6); assert.equal(b.reading.usage[0].out, 2e6); // never summed across accounts
  assert.equal(a.usd, 25); assert.equal(a.perBar, 250); assert.equal(b.perBar, 250);
  assert.deepEqual(a.reading.req, ["a1"]); assert.ok(a.reading.ambiguous_share > 0);
});

test("privacy: payload carries only allow-listed keys and no content, paths, session ids or raw ids", () => {
  const d = mkdtempSync(join(tmpdir(), "gc-")); mkdirSync(join(d, "projects", "p"), { recursive: true });
  copyFileSync(join(FX, "claude-session.jsonl"), join(d, "projects", "p", "s.jsonl"));
  const entries = scanClaude(d, 0);
  const r = buildReading({ vendor: "claude", plan: "claude-max-20x", seat: "personal_max20x", bar: { t: T("2026-10-12T10:00:00Z"), account: ACC_A, dir: d, kind: "weekly", pct: 30, reset: T("2026-10-16T08:00:00Z"), source: "statusline" }, entries, timeline: [{ t: T("2026-10-12T07:00:00Z"), vendor: "claude", dir: d, account: ACC_A }] });
  const payload = { v: 1, client: "0.1.0", device: "ab".repeat(16), readings: [r.reading] };
  const s = JSON.stringify(payload);
  for (const bad of ["SECRET", "private-repo", "/Users", d, "sess-should-not-leak", "msg_1", "req_1", "uuid-A", "main", "@"]) assert.ok(!s.includes(bad), `leaked ${bad}`);
  const allowed = new Set(["v", "client", "device", "proof", "readings", "vendor", "plan", "account", "seat", "kind", "reset_at", "bar", "pct", "read_at", "source", "data_start", "data_end", "attribution", "ambiguous_share", "usage", "m", "in", "out", "cr", "cw", "cw1h", "lc", "req"]);
  const walk = (o: any) => { if (Array.isArray(o)) return o.forEach(walk); if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { assert.ok(allowed.has(k), `unexpected key ${k}`); walk(v); } };
  walk(payload);
  assert.match(String(previewOf(payload).readings[0].req), /one-way hashes/);
});

test("latestBars keeps the newest reading of the current window per account", () => {
  const now = T("2026-10-13T10:00:00Z"), reset = T("2026-10-16T08:00:00Z");
  const b = (t: string, pct: number, account: string | null = ACC_A) => ({ t: T(t), account, dir: "/d", kind: "weekly" as const, pct, reset, source: "statusline" as const });
  const got = latestBars([b("2026-10-12T10:00:00Z", 20), b("2026-10-13T09:00:00Z", 35), b("2026-10-13T09:30:00Z", 50, null)], now);
  assert.equal(got.length, 1); assert.equal(got[0].pct, 35);
});

test("account files: Claude plan tier + Codex account id are hashed, never raw", () => {
  const h = mkdtempSync(join(tmpdir(), "gc-h-")); const old = process.env.HOME; process.env.HOME = h;
  try {
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-A", organizationUuid: "org-A", emailAddress: "ali@example.com", organizationType: "claude_max", userRateLimitTier: "default_claude_max_20x" } }));
    const c = claudeAccount(join(h, ".claude")); assert.equal(c.account, ACC_A); assert.equal(c.plan, "claude-max-20x");
    mkdirSync(join(h, ".codex")); const jwt = "x." + Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro", chatgpt_account_id: "acc-1" } })).toString("base64url") + ".y";
    writeFileSync(join(h, ".codex", "auth.json"), JSON.stringify({ tokens: { id_token: jwt, account_id: "acc-1" } }));
    const x = codexAccount(join(h, ".codex")); assert.equal(x.plan, "chatgpt-pro-200"); assert.equal(x.account, accountKey("codex", "acc-1"));
  } finally { process.env.HOME = old; }
});

test("end to end (fixtures): hook records the bar, dry run builds a payload, nothing is sent", () => {
  const h = mkdtempSync(join(tmpdir(), "gc-e2e-")); const cli = join(__dirname, "..", "..", "dist", "cli.js");
  mkdirSync(join(h, ".claude", "projects", "p"), { recursive: true });
  const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
  const lines = readFileSync(join(FX, "claude-session.jsonl"), "utf8").replace(/2026-10-12T08:00:05.000Z/g, iso(now - 3 * 36e5)).replace(/2026-10-12T09:00:00.000Z/g, iso(now - 2 * 36e5));
  writeFileSync(join(h, ".claude", "projects", "p", "s.jsonl"), lines);
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "uuid-A", organizationUuid: "org-A", organizationType: "claude_max", userRateLimitTier: "default_claude_max_20x" } }));
  const env = { ...process.env, HOME: h, GOTCAPPED_HOME: join(h, ".gotcapped"), CODEX_HOME: join(h, "no-codex"), CLAUDE_CONFIG_DIR: "" };
  delete (env as any).CLAUDE_CONFIG_DIR;
  const hook = spawnSync(process.execPath, [cli, "hook", "statusline"], { env, input: JSON.stringify({ model: { display_name: "Opus" }, rate_limits: { seven_day: { used_percentage: 20, resets_at: Math.floor((now + 3 * 864e5) / 1000) } } }), encoding: "utf8" });
  assert.match(hook.stdout, /week 20%/);
  const run = spawnSync(process.execPath, [cli, "--dry-run", "--no-prompt"], { env, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Claude Max 20x gave \$/); assert.match(run.stdout, /Dry run: nothing sent/);
  const p = JSON.parse(readFileSync(join(h, ".gotcapped", "outbox", "last.json"), "utf8"));
  assert.equal(p.readings[0].plan, "claude-max-20x"); assert.equal(p.readings[0].bar.source, "statusline"); assert.equal(p.readings[0].attribution, "inferred");
  assert.ok(!JSON.stringify(p).includes("SECRET"));
  const st = JSON.parse(readFileSync(join(h, ".gotcapped", "state.json"), "utf8"));
  assert.match(p.proof, /^[0-9a-f]{64}$/); assert.ok(!JSON.stringify(p).includes(st.secret), "device secret must never be in the upload");
  assert.equal(p.proof, require("crypto").createHash("sha256").update(st.secret).digest("hex"));
});

test("forget: sends DELETE with the device secret, then wipes local state; keeps it if the server fails", async () => {
  const http = await import("http");
  let seen: any = null, code = 200;
  const srv = http.createServer((req, res) => { seen = { method: req.method, url: req.url, secret: req.headers["x-device-secret"] }; res.statusCode = code; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(code === 200 ? { ok: true, deleted: 2 } : { ok: false, error: "boom" })); });
  await new Promise<void>((r) => srv.listen(0, r)); const port = (srv.address() as any).port;
  const { spawn } = await import("child_process");
  const run = (h: string) => new Promise<{ code: number; out: string }>((r) => { const p = spawn(process.execPath, [join(__dirname, "..", "..", "dist", "cli.js"), "forget", "--endpoint", `http://127.0.0.1:${port}/api/ingest`], { env: { ...process.env, HOME: h, GOTCAPPED_HOME: join(h, ".gc") } }); let out = ""; p.stdout.on("data", (c) => (out += c)); p.on("exit", (c) => r({ code: c ?? 0, out })); });
  try {
    const h = mkdtempSync(join(tmpdir(), "gc-f-")); mkdirSync(join(h, ".gc")); writeFileSync(join(h, ".gc", "state.json"), JSON.stringify({ device: "a".repeat(32), secret: "b".repeat(64) }));
    code = 500; let r = await run(h);
    assert.equal(r.code, 1); assert.ok(existsSync(join(h, ".gc", "state.json")), "local state kept when server delete fails");
    code = 200; r = await run(h);
    assert.equal(seen.method, "DELETE"); assert.equal(seen.url, `/api/ingest?device=${"a".repeat(32)}`); assert.equal(seen.secret, "b".repeat(64));
    assert.match(r.out, /deleted 2/); assert.ok(!existsSync(join(h, ".gc")));
  } finally { srv.close(); }
});

test("real local logs on this machine parse without errors (skipped when absent)", (t) => {
  const d = join(homedir(), ".claude"); if (!existsSync(join(d, "projects"))) return t.skip("no ~/.claude/projects");
  const es = scanClaude(d, 0); assert.ok(es.every((e) => e.req.length === 16 && e.t > 0));
  const cx = join(homedir(), ".codex", "sessions");
  const files: string[] = []; const w = (p: string) => { for (const n of existsSync(p) ? readdirSync(p, { withFileTypes: true }) : []) n.isDirectory() ? w(join(p, n.name)) : n.name.startsWith("rollout-") && files.push(join(p, n.name)); }; w(cx);
  const ce = files.flatMap((f) => parseRollout(readFileSync(f, "utf8"), f).entries);
  console.log(`real logs: ${es.length} Claude entries, ${ce.length} Codex entries, $${priceUsage(es.map((e) => ({ m: e.m, in: e.in, out: e.out, cr: e.cr, cw: e.cw, cw1h: e.cw1h }))).usd.toFixed(2)} Claude API value`);
});

test("long-context: only requests above the model's threshold are counted (lc), per request", () => {
  const mk = (t: number, cr: number, req: string) => ({ t, m: "gpt-6.1-sol", in: 10000, out: 100, cr, cw: 0, cw1h: 0, req });
  const now = Date.parse("2026-10-13T10:00:00Z");
  const r = buildReading({ vendor: "codex", plan: "chatgpt-pro-200", bar: { t: now, account: ACC_A, dir: "/c", kind: "weekly", pct: 30, reset: now + 3 * 864e5, source: "rpc" },
    entries: [mk(now - 36e5, 100000, "r1"), mk(now - 2 * 36e5, 300000, "r2")], timeline: [{ t: now - 5 * 864e5, vendor: "codex", dir: "/c", account: ACC_A }] });
  assert.equal(r.reading.usage[0].lc, 1);
  const r2 = buildReading({ vendor: "codex", plan: "chatgpt-pro-200", bar: { t: now, account: ACC_A, dir: "/c", kind: "weekly", pct: 30, reset: now + 3 * 864e5, source: "rpc" },
    entries: [mk(now - 36e5, 100000, "r1")], timeline: [{ t: now - 5 * 864e5, vendor: "codex", dir: "/c", account: ACC_A }] });
  assert.ok(!("lc" in r2.reading.usage[0]));
});
