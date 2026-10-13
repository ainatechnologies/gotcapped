# Ingest re-key — not deployed

Account keys and request hashes that leave the machine are `HMAC-SHA256` under the public pepper `gotcapped-pepper-v1` (`gotcapped-cli/src/util.ts`). The pepper is public so every install produces the same bytes: that is how two devices of one account merge, and how a request uploaded last week still matches a re-upload. Anyone who already knows the raw account UUID or request id can recompute those bytes and match them to a database row, a log line, or a backup.

This repo has no ingest service. The fix is a second HMAC on the server, specified and tested in `gotcapped-cli/src/shared/ingest-rekey.ts`. Do not change the client hash, do not add a payload field, and do not ship a client release for this.

## Why not a per-install secret

A secret that stays on the laptop would make the on-wire hash non-recomputable, and it would also make the laptop and the desktop disagree. Reports for one account would split, and request de-dup would miss rows already stored under the public pepper (including uploads from binaries that never update). The server is the only place that can see every copy of the public token and replace it with one stored id.

## What clients send (unchanged)

`POST /api/ingest` body, version `v: 1`:

| Field | Wire form | Stored form after re-key |
|---|---|---|
| `readings[].account` | 32 lowercase hex, `HMAC(pepper, "acct:<vendor>:<accountId>:<orgId>")` | 32 lowercase hex, `HMAC(secret, "gotcapped-ingest-acct-v1:<wire>")` |
| `readings[].req[]` | 16 lowercase hex, `HMAC(pepper, "req:<vendor>:<id>")` | 16 lowercase hex, `HMAC(secret, "gotcapped-ingest-req-v1:<wire>")` |
| `device`, `proof` | unchanged | unchanged. Do not re-key these. `DELETE /api/ingest?device=` still takes the raw device id, and `proof` is still `sha256(device secret)`. |

No new key is allowed on the body. `hk` is a database column, not a request field. If a client sends `hk`, ignore it and still re-key `account` and `req`. Reject any `account` that is not 32 lowercase hex or any `req` entry that is not 16 lowercase hex with HTTP 400 — do not store a raw UUID under the server secret (that would be a third identity).

The HMAC key is the UTF-8 bytes of the env string, not the hex-decoded bytes. Column widths stay the same.

## Secret

- Env: `GOTCAPPED_INGEST_SECRET` (at least 32 characters; 32 random bytes, hex-encoded, is a good value).
- Generate it once. Store it in the secret manager. It is not in this repo, not in the database, not in logs, and not in any client.
- Do not rotate it. The stored value is `HMAC(secret, wire token)`. A new secret cannot be derived from the stored value, so rotation would split every account that still has an unmigrated row and would break de-dup. Treat it as a long-term key. If it leaks together with a database dump, the dump is matchable again; the response is a new secret plus a fresh migration only if you still have the wire tokens (you will not, after this migration). Preventing the leak is the control.

## Rollout order

1. **Deploy the read and write path first.** New writes store only the re-keyed form with `hk = 2`. Reads canonicalize both forms (below) for account grouping and for request de-dup. Old rows stay `hk` null or `1` until the backfill. Dual-read is what keeps de-dup correct while both forms exist. Do not log `account` or `req` from the request body; log them only after re-key, or not at all.
2. **Backfill.** For each reading with `hk` null or `1`, in one transaction: replace `account` and every `req` via `migrateReading`, then set `hk = 2`. Select `FOR UPDATE`. Do not set `hk = 2` before the hashes in that row are rewritten. Re-running the job is safe: `hk = 2` is returned unchanged (`migrateReading` is idempotent).
3. **Verify** `count(*) where hk is null or hk = 1` is 0, and that a sample account's wire token re-keys to the value now stored.
4. **Leave dual-read on.** It is cheap and it protects a replica that is behind. Removing it is optional and only after the count in step 3 has stayed 0.
5. **No client release.** Current `npx gotcapped` and the shipping tray already send the wire form. Do not publish this change to npm and do not ship a new dmg for it. A later client release must keep `PEPPER`, `accountMaterial`, and `reqMaterial` exactly as they are (locked by `gotcapped-cli/test/rekey.test.ts`).

Old clients after step 1 behave as they do today: same JSON, same hashes. The server re-keys on the way in, so they land on the same stored account as a migrated row and their request hashes still match.

## De-dup and multi-account

De-dup scope stays whatever production uses today, then both sides are canonicalized. The reference compares within one stored account: pass the prior rows you already compare against (include the reset window if that is part of the match). `rekeyReading` ignores other accounts, so account B is never treated as a duplicate of account A's requests and the two never share a bar.

Status from that helper:

- `duplicate` — every incoming request hash is already stored for this account. Do not add the usage again. This is the same case as today's `results[].status = "duplicate"`.
- `overlap` — some hashes are new. Apply the same partial-overlap rule production uses now. Which hashes count as "the same request" does not change; only the stored bytes do.
- `fresh` — none of the hashes are stored, including an empty `req` list (an empty list is not a duplicate of everything).

Canonical form:

- `hk` null or `1`: stored bytes are the wire token. Compare as `rekey(secret, wire)`.
- `hk = 2`: stored bytes are already re-keyed. Compare as-is. Do not hash them again.
- Any other `hk`: fail the row. Do not guess.

Account grouping uses the same canonical account, so a legacy row and a new row for one person collapse to one id as soon as step 1 is live, even before that row is backfilled.

## API compatibility

- Request schema: unchanged. Old clients keep working against the new server.
- `device` and `proof`: unchanged. Deletion and the first-upload pin keep using them.
- Response: if `results[].account` currently echoes the request's account, stop echoing the wire token. Omit it, or return the stored id. The CLI only prints that field; either choice keeps old clients working. Echoing the wire token puts the recomputable value back on the wire.
- Crowd medians: unchanged. They are aggregates and do not include account or request hashes.

## Privacy wording to publish

Publish this only after step 3. Until the backfill finishes, the website and the app must not claim the stored data is already re-keyed. The in-app consent string stays at version 1: the upload body does not change, so do not re-prompt.

Replace the public pepper paragraph (the one that says the hash cannot be reversed by guessing, on `gotcapped.com/privacy` and mirrored in the CLI README) with:

> Account keys and request-id hashes are computed on your device with HMAC-SHA256 and a public pepper (`gotcapped-pepper-v1`) so the same account matches across your devices and the same request is not counted twice. The pepper is not a secret. It stops anyone from guessing a random account id, but someone who already knows your account id or a request id could recompute the on-device hash. Before we store those values we hash them again with a secret that stays on our server. A copy of the database cannot be matched back to an account id or a request id without that secret. We do not store the on-device hash. The upload does not include your raw account id, request id, prompts, or file paths.

Shorter line for the tray "what we send" list and the plan pages, same timing:

> A hash of your account id (never the id). We hash it again on the server with a secret key before storing it, so a known account id cannot be matched to your reports.

Server-side sentence that is already true and stays: IPs are used only for rate limiting and stored only as salted hashes. Plan pages show aggregates only.
