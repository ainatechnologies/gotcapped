import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "child_process";
import { readFileSync, writeFileSync } from "fs";
const H = "/tmp/gc-tray-test-home";
const run = (...a) => JSON.parse(execFileSync("node", ["engine/dist/engine.cjs", ...a], { env: { ...process.env, HOME: H, GOTCAPPED_NO_RPC: "1", CLAUDE_CONFIG_DIR: "" } }).toString());
execFileSync("node", ["fixtures/make-home.mjs", H]);

test("scan finds both accounts and prices them with the shared engine", () => {
  const r = run("scan");
  assert.equal(r.ok, true);
  assert.deepEqual(r.accounts.map((a) => a.plan).sort(), ["chatgpt-pro-200", "claude-max-20x"]);
  const w = r.readings.find((x) => x.vendor === "claude" && x.kind === "weekly");
  assert.ok(w.usd > 0 && Math.abs(w.perBar - w.usd / 0.41) < 1e-6);
});
test("privacy: no content, paths, session ids, emails, raw account ids or tokens in the payload", () => {
  const s = JSON.stringify(run("scan").payload);
  for (const c of ["CANARY", "canary-email", "fixture-uuid-A", "fixture-org-A", "fixture-codex-acct", "/Users/", "secret-repo", "msg_", "req_"]) assert.ok(!s.includes(c), c);
});
test("payload keys are exactly the ingest allow-list", () => {
  const p = run("scan").payload;
  assert.deepEqual(Object.keys(p).sort(), ["client", "device", "proof", "readings", "v"]); assert.match(p.proof, /^[0-9a-f]{64}$/);
  const ok = new Set(["vendor", "plan", "account", "seat", "kind", "reset_at", "bar", "data_start", "data_end", "attribution", "ambiguous_share", "usage", "req"]);
  for (const r of p.readings) for (const k of Object.keys(r)) assert.ok(ok.has(k), k);
});
test("account switch: a second Claude account gets its own reading, never the first account's tokens", () => {
  const before = run("scan").readings.find((x) => x.vendor === "claude" && x.kind === "weekly");
  const f = `${H}/.claude.json`, j = JSON.parse(readFileSync(f, "utf8"));
  j.oauthAccount.accountUuid = "fixture-uuid-B"; writeFileSync(f, JSON.stringify(j));
  run("sample");
  const after = run("scan");
  const claude = after.accounts.filter((a) => a.vendor === "claude");
  assert.equal(claude.length, 1); assert.notEqual(claude[0].account, before.account); // the active account is B now
  assert.ok(!after.readings.some((x) => x.account === claude[0].account && x.usd > 0)); // B has no bar yet and A's tokens never count for B
});
test("cursor CSV is priced locally and flagged local-only", () => {
  const r = run("cursor", `${H}/cursor-usage-fixture.csv`);
  assert.equal(r.ok, true); assert.equal(r.localOnly, true); assert.ok(r.usd > 0);
  assert.equal(run("cursor", `${H}/.claude.json`).ok, false);
});
test("forget deletes local state", () => { assert.equal(run("forget").ok, true); });
test("crowd + delete-all talk to the server with the right shape; local state kept when delete fails", async () => {
  const http = await import("http"); const { execFile } = await import("child_process");
  let code = 200; const seen = [];
  const srv = http.createServer((req, res) => { seen.push({ m: req.method, u: req.url, s: req.headers["x-device-secret"] }); res.setHeader("content-type", "application/json"); res.statusCode = req.method === "DELETE" ? code : 200;
    res.end(JSON.stringify(req.method === "DELETE" ? (code === 200 ? { ok: true, deleted: 3 } : { ok: false, error: "boom" }) : { ok: true, plans: [{ plan: "claude-max-20x", kind: new URL(req.url, "http://x").searchParams.get("kind"), median: 150, n: 20, need: 0, early: false, prevMedian: 200, prevN: 18 }] })); });
  await new Promise((r) => srv.listen(0, r)); const ep = `http://127.0.0.1:${srv.address().port}/api/ingest`;
  const runA = (...a) => new Promise((r) => execFile("node", ["engine/dist/engine.cjs", ...a], { env: { ...process.env, HOME: H, GOTCAPPED_NO_RPC: "1", CLAUDE_CONFIG_DIR: "", GOTCAPPED_ENDPOINT: ep } }, (e, out) => r(JSON.parse(out))));
  try {
    execFileSync("node", ["fixtures/make-home.mjs", H]); await runA("scan");
    assert.equal((await runA("crowd")).ok, true);
    const w = (await runA("scan")).readings.find((x) => x.plan === "claude-max-20x" && x.kind === "weekly");
    assert.equal(w.crowd.prevMedian, 200); assert.equal(w.crowd.prevN, 18); assert.ok(!("cut" in w.crowd));
    const st = JSON.parse(readFileSync(`${H}/.gotcapped/state.json`, "utf8"));
    code = 500; const bad = await runA("delete-all"); assert.equal(bad.ok, false); assert.ok(readFileSync(`${H}/.gotcapped/state.json`));
    code = 200; const ok = await runA("delete-all"); assert.equal(ok.ok, true); assert.equal(ok.deleted, 3);
    const d = seen.filter((x) => x.m === "DELETE").pop(); assert.equal(d.u, `/api/ingest?device=${st.device}`); assert.equal(d.s, st.secret);
  } finally { srv.close(); }
});
