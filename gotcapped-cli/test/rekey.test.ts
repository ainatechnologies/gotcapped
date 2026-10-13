import { test } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "crypto";
import { mkdtempSync, mkdirSync, copyFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { accountKey, reqHash, PEPPER, accountMaterial, reqMaterial } from "../src/util";
import { buildReading, previewOf } from "../src/build";
import { scanClaude } from "../src/claude";
import { canonicalAccount, canonicalReqs, migrateReading, rekeyAccount, rekeyReading, rekeyReq, ACCT_LABEL, REQ_LABEL, INGEST_SECRET_ENV } from "../src/shared/ingest-rekey";

// Frozen wire tokens. Production rows and not-yet-updated clients already use these bytes.
const WIRE_ACCT = "16667bf77db79e815edf8a5521e770a1";
const WIRE_REQ = "f4f9b40df623160d";
const SECRET = "test-ingest-secret-0123456789abcd";
const STORED_ACCT = "7dfbc4ec8844df2bf5f8772038d9da2d";
const STORED_REQ = "9139c945fc944bbe";
const ALLOWED = new Set(["v", "client", "device", "proof", "readings", "vendor", "plan", "account", "seat", "kind", "reset_at", "bar", "pct", "read_at", "source", "data_start", "data_end", "attribution", "ambiguous_share", "usage", "m", "in", "out", "cr", "cw", "cw1h", "lc", "req"]);

const legacyHmac = (s: string, len: number) => createHmac("sha256", "gotcapped-pepper-v1").update(s).digest("hex").slice(0, len);

test("wire hashes stay the public-pepper tokens already in production", () => {
  assert.equal(PEPPER, "gotcapped-pepper-v1");
  assert.equal(accountMaterial("claude", "uuid-A", "org-A"), "acct:claude:uuid-A:org-A");
  assert.equal(reqMaterial("claude", "msg_1:req_1"), "req:claude:msg_1:req_1");
  // Independent of accountKey/reqHash, so a quiet change to both the helper and its caller still fails.
  assert.equal(legacyHmac("acct:claude:uuid-A:org-A", 32), WIRE_ACCT);
  assert.equal(legacyHmac("req:claude:msg_1:req_1", 16), WIRE_REQ);
  assert.equal(accountKey("claude", "uuid-A", "org-A"), WIRE_ACCT);
  assert.equal(reqHash("claude", "msg_1:req_1"), WIRE_REQ);
  assert.equal(accountKey("codex", "acc-1"), legacyHmac("acct:codex:acc-1:", 32));
  // An outsider who knows the raw id can recompute the value that leaves the machine.
  assert.equal(accountKey("claude", "uuid-A", "org-A"), WIRE_ACCT);
});

test("stored form is not recomputable without the server secret, and is stable", () => {
  assert.equal(rekeyAccount(SECRET, WIRE_ACCT), STORED_ACCT);
  assert.equal(rekeyReq(SECRET, WIRE_REQ), STORED_REQ);
  assert.equal(createHmac("sha256", SECRET).update(`${ACCT_LABEL}:${WIRE_ACCT}`).digest("hex").slice(0, 32), STORED_ACCT);
  assert.equal(createHmac("sha256", SECRET).update(`${REQ_LABEL}:${WIRE_REQ}`).digest("hex").slice(0, 16), STORED_REQ);
  assert.notEqual(STORED_ACCT, WIRE_ACCT);
  assert.notEqual(rekeyAccount("another-ingest-secret-0123456789abcd", WIRE_ACCT), STORED_ACCT);
  assert.equal(rekeyAccount(SECRET, WIRE_ACCT).includes("uuid-A"), false);
  assert.throws(() => rekeyAccount("", WIRE_ACCT), new RegExp(INGEST_SECRET_ENV));
  assert.throws(() => rekeyAccount(SECRET, "uuid-A"));
  assert.throws(() => rekeyReq(SECRET, "req_1"));
});

test("same account on two devices stays one stored account; two accounts stay two", () => {
  const laptop = accountKey("claude", "uuid-A", "org-A");
  const desktop = accountKey("claude", "uuid-A", "org-A");
  const other = accountKey("claude", "uuid-B", "org-B");
  assert.equal(rekeyAccount(SECRET, laptop), rekeyAccount(SECRET, desktop));
  assert.notEqual(rekeyAccount(SECRET, laptop), rekeyAccount(SECRET, other));
  assert.notEqual(accountKey("claude", "same", ""), accountKey("codex", "same", ""));
  assert.notEqual(rekeyAccount(SECRET, accountKey("claude", "same", "")), rekeyAccount(SECRET, accountKey("codex", "same", "")));
});

test("de-dup matches legacy rows, migrated rows, and old clients; a second account is not suppressed", () => {
  const h1 = reqHash("claude", "msg_1:req_1"), h2 = reqHash("claude", "msg_2:req_2"), h3 = reqHash("claude", "msg_3:req_3");
  const acct = accountKey("claude", "uuid-A", "org-A");
  const other = accountKey("claude", "uuid-B", "org-B");
  // What an already-uploaded row looks like, and what an old binary still sends.
  const legacy = { account: acct, req: [h1, h2], hk: 1 as const, plan: "claude-max-20x" };
  const oldClient = { account: legacyHmac(accountMaterial("claude", "uuid-A", "org-A"), 32), req: [h2, h3], vendor: "claude", plan: "claude-max-20x" };
  assert.equal(oldClient.account, acct);

  const againstLegacy = rekeyReading(SECRET, oldClient, [legacy]);
  assert.equal(againstLegacy.status, "overlap");
  assert.deepEqual(againstLegacy.duplicateReq, [rekeyReq(SECRET, h2)]);
  assert.deepEqual(againstLegacy.freshReq, [rekeyReq(SECRET, h3)]);
  assert.equal(againstLegacy.account, rekeyAccount(SECRET, acct));
  assert.equal(againstLegacy.reading.plan, "claude-max-20x");
  assert.equal(againstLegacy.reading.hk, 2);

  const migrated = migrateReading(SECRET, legacy);
  assert.equal(migrated.account, againstLegacy.account);
  assert.deepEqual(migrated.req, [rekeyReq(SECRET, h1), rekeyReq(SECRET, h2)].sort());
  const again = migrateReading(SECRET, migrated);
  assert.deepEqual(again, migrated); // re-running the backfill does not split the account

  const againstMigrated = rekeyReading(SECRET, { account: acct, req: [h1, h2] }, [migrated]);
  assert.equal(againstMigrated.status, "duplicate");
  assert.deepEqual(againstMigrated.freshReq, []);
  assert.equal(againstMigrated.account, migrated.account);

  const replay = rekeyReading(SECRET, { account: acct, req: [h1, h2] }, [againstLegacy.reading]);
  assert.equal(replay.status, "overlap"); // h1 was not in that upload; h2 was
  const full = rekeyReading(SECRET, { account: acct, req: [h2, h3] }, [againstLegacy.reading]);
  assert.equal(full.status, "duplicate");

  // Same request hashes under a different account are a different bar, not a duplicate.
  const b = rekeyReading(SECRET, { account: other, req: [h1, h2] }, [migrated, againstLegacy.reading]);
  assert.equal(b.status, "fresh");
  assert.notEqual(b.account, migrated.account);
  assert.equal(b.duplicateReq.length, 0);

  // A client cannot set hk and have the public token stored as if it were already re-keyed.
  const lied = rekeyReading(SECRET, { account: acct, req: [h3], hk: 2 }, []);
  assert.equal(lied.reading.account, rekeyAccount(SECRET, acct));
  assert.notEqual(lied.reading.account, acct);
  assert.deepEqual(lied.reading.req, [rekeyReq(SECRET, h3)]);
});

test("null hk is legacy; unknown hk fails closed; raw ids are rejected", () => {
  const acct = accountKey("claude", "uuid-A", "org-A");
  assert.equal(canonicalAccount(SECRET, acct, null), rekeyAccount(SECRET, acct));
  assert.equal(canonicalAccount(SECRET, STORED_ACCT, 2), STORED_ACCT);
  assert.throws(() => canonicalAccount(SECRET, acct, 3));
  assert.throws(() => migrateReading(SECRET, { account: "not-a-hash", req: [], hk: 1 }));
  assert.throws(() => rekeyReading(SECRET, { account: acct, req: ["REQ_1"] }, []));
  assert.equal(rekeyReading(SECRET, { account: acct, req: [] }, []).status, "fresh");
  assert.deepEqual(canonicalReqs(SECRET, [WIRE_REQ, WIRE_REQ], 1), [STORED_REQ]);
});

test("upload allow-list is unchanged: re-key is not applied on the device and no new field leaves", () => {
  const d = mkdtempSync(join(tmpdir(), "gc-")); mkdirSync(join(d, "projects", "p"), { recursive: true });
  copyFileSync(join(__dirname, "..", "..", "test", "fixtures", "claude-session.jsonl"), join(d, "projects", "p", "s.jsonl"));
  const acct = accountKey("claude", "uuid-A", "org-A");
  const entries = scanClaude(d, 0);
  const local = buildReading({ vendor: "claude", plan: "claude-max-20x", seat: "personal_max20x", bar: { t: Date.parse("2026-10-12T10:00:00Z"), account: acct, dir: d, kind: "weekly", pct: 30, reset: Date.parse("2026-10-16T08:00:00Z"), source: "statusline" }, entries, timeline: [{ t: Date.parse("2026-10-12T07:00:00Z"), vendor: "claude", dir: d, account: acct }] });
  const payload = { v: 1, client: "0.1.0", device: "ab".repeat(16), proof: "cd".repeat(32), readings: [local.reading] };
  const before = JSON.stringify(payload);
  const walk = (o: any) => { if (Array.isArray(o)) return o.forEach(walk); if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { assert.ok(ALLOWED.has(k), `unexpected key ${k}`); walk(v); } };
  walk(payload);
  assert.equal(local.reading.account, acct);
  assert.ok(local.reading.req.every((r) => /^[0-9a-f]{16}$/.test(r)));
  assert.equal(JSON.stringify(payload).includes("uuid-A"), false);
  assert.equal(JSON.stringify(payload).includes(SECRET), false);
  assert.match(String(previewOf(payload).readings[0].req), /one-way hashes/);
  const stored = rekeyReading(SECRET, local.reading, []);
  assert.equal(JSON.stringify(payload), before); // re-key does not touch the body that leaves the machine
  assert.equal(stored.reading.account, rekeyAccount(SECRET, acct));
  assert.notEqual(stored.reading.account, acct);
  assert.equal(stored.reading.hk, 2);
  assert.ok(!("hk" in local.reading));
  assert.deepEqual(stored.reading.usage, local.reading.usage);
  assert.equal(stored.status, "fresh");
  // A second upload of the same logs is a duplicate against either the legacy row or the stored row.
  const legacy = { account: acct, req: local.reading.req, hk: null as null };
  assert.equal(rekeyReading(SECRET, local.reading, [legacy]).status, "duplicate");
  assert.equal(rekeyReading(SECRET, local.reading, [stored.reading]).status, "duplicate");
  assert.equal(rekeyReading(SECRET, local.reading, [migrateReading(SECRET, legacy)]).account, stored.account);
});
