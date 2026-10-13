// Server-only second hash for account keys and request ids. Not used on the upload path.
//
// Clients keep sending HMAC(public pepper, id). That value is a correlation token: the same account
// matches across devices, and a request re-uploaded by an old build still matches rows already stored.
// It is recomputable by anyone who knows the raw id. Before storage, ingest HMACs it again under
// GOTCAPPED_INGEST_SECRET. Outsiders cannot recompute the stored form. The secret never ships in a client.
//
// Hash-key versions live only in the database:
//   1 (or null) — the client token, as historically stored
//   2           — HMAC(server secret, label || client token)
// Do not accept a version from the client. A client that sent hk must still be re-keyed from its account/req.
import { createHmac } from "crypto";

export const INGEST_SECRET_ENV = "GOTCAPPED_INGEST_SECRET";
export const HASH_KEY_CLIENT = 1;
export const HASH_KEY_STORED = 2;
/** Domain labels. Changing either one splits every account and breaks request de-dup. */
export const ACCT_LABEL = "gotcapped-ingest-acct-v1";
export const REQ_LABEL = "gotcapped-ingest-req-v1";

const ACCT_RE = /^[0-9a-f]{32}$/;
const REQ_RE = /^[0-9a-f]{16}$/;

export type HashKeyVersion = 1 | 2;
export type DedupStatus = "fresh" | "duplicate" | "overlap";
export type ClientReading = { account: string; req: string[] };
export type PriorReading = { account: string; req: string[]; hk?: number | null };
export type StoredReading<T extends ClientReading> = Omit<T, "account" | "req"> & { account: string; req: string[]; hk: 2 };
export type RekeyResult<T extends ClientReading> = {
  reading: StoredReading<T>; status: DedupStatus; freshReq: string[]; duplicateReq: string[]; account: string;
};

export function assertIngestSecret(secret: string) {
  if (typeof secret !== "string" || secret.length < 32) throw new Error(`${INGEST_SECRET_ENV} must be at least 32 characters`);
}
export function hashKeyOf(hk: number | null | undefined): HashKeyVersion {
  if (hk == null || hk === HASH_KEY_CLIENT) return HASH_KEY_CLIENT;
  if (hk === HASH_KEY_STORED) return HASH_KEY_STORED;
  throw new Error(`unknown hash key version ${hk}`);
}
export const isClientAccount = (s: string) => ACCT_RE.test(s);
export const isClientReq = (s: string) => REQ_RE.test(s);

function keyed(secret: string, label: string, clientHash: string, len: number) {
  assertIngestSecret(secret);
  // UTF-8 of the env string, verbatim. Do not hex-decode it or the stored ids will not match.
  return createHmac("sha256", secret).update(`${label}:${clientHash}`).digest("hex").slice(0, len);
}
export const rekeyAccount = (secret: string, clientAccount: string) => { if (!isClientAccount(clientAccount)) throw new Error("account key must be 32 lowercase hex chars"); return keyed(secret, ACCT_LABEL, clientAccount, 32); };
export const rekeyReq = (secret: string, clientReq: string) => { if (!isClientReq(clientReq)) throw new Error("req hash must be 16 lowercase hex chars"); return keyed(secret, REQ_LABEL, clientReq, 16); };

/** Map a stored value to the hk=2 form. hk=2 is returned unchanged so a backfill can be re-run. */
export function canonicalAccount(secret: string, account: string, hk?: number | null): string {
  assertIngestSecret(secret);
  if (!isClientAccount(account)) throw new Error("account key must be 32 lowercase hex chars");
  return hashKeyOf(hk) === HASH_KEY_STORED ? account : rekeyAccount(secret, account);
}
export function canonicalReqs(secret: string, reqs: string[], hk?: number | null): string[] {
  assertIngestSecret(secret);
  if (!Array.isArray(reqs)) throw new Error("req must be an array of hashes");
  for (const r of reqs) if (!isClientReq(r)) throw new Error("req hash must be 16 lowercase hex chars");
  // Already-stored rows are returned in their existing order so a re-run does not rewrite them.
  if (hashKeyOf(hk) === HASH_KEY_STORED) return reqs.slice();
  return [...new Set(reqs.map((r) => rekeyReq(secret, r)))].sort();
}

export function migrateReading<T extends PriorReading>(secret: string, reading: T): Omit<T, "hk"> & { account: string; req: string[]; hk: 2 } {
  return { ...reading, account: canonicalAccount(secret, reading.account, reading.hk), req: canonicalReqs(secret, reading.req, reading.hk), hk: HASH_KEY_STORED };
}

function dedupStatus(incoming: number, fresh: number): DedupStatus {
  if (incoming === 0 || fresh === incoming) return "fresh";
  if (fresh === 0) return "duplicate";
  return "overlap";
}

/**
 * Re-key one uploaded reading and compare its request hashes to rows already stored for this account.
 * `prior` is whatever scope production already uses for de-dup (pass the window too, if that is how it matches).
 * Other accounts in `prior` are ignored, so two accounts never suppress each other.
 * A client-supplied `hk` is ignored: the body is always the public-pepper token.
 */
export function rekeyReading<T extends ClientReading>(secret: string, reading: T, prior: PriorReading[] = []): RekeyResult<T> {
  const account = rekeyAccount(secret, reading.account);
  const req = canonicalReqs(secret, reading.req, HASH_KEY_CLIENT);
  const seen = new Set<string>();
  for (const row of prior) {
    if (canonicalAccount(secret, row.account, row.hk) !== account) continue;
    for (const h of canonicalReqs(secret, row.req, row.hk)) seen.add(h);
  }
  const freshReq = req.filter((h) => !seen.has(h));
  const duplicateReq = req.filter((h) => seen.has(h));
  // hk on the body is ignored: overwrite it so a client cannot mark a public token as already stored.
  return { account, freshReq, duplicateReq, status: dedupStatus(req.length, freshReq.length), reading: { ...reading, account, req, hk: HASH_KEY_STORED } };
}
