# Server pieces the tray expects — DONE (13 Oct 2026, preview only)
1. `DELETE /api/ingest?device=<32-hex>` with header `x-device-secret: <64-hex>`. The client keeps a random secret; every upload
   carries `proof = sha256(secret)`, which the server pins to the device on first sight (TOFU). Uploads with another proof
   get 403; DELETE needs the secret itself. Responses: 200 `{ok, deleted}`, 400 bad input, 403 wrong secret, 404 nothing
   registered, 429 rate-limited (10/h per IP). Engine: `engine delete-all` (server first, local kept if it fails).
   Ed25519 signing (§6) can replace this later; the secret already stops strangers deleting or overwriting others' data.
2. `GET /api/ingest/crowd?plan=<id>&kind=weekly|5h` (plan optional → `{plans:[…]}`): `{ median, n, need, early, counts,
   prevMedian, prevN }`. `median` is the live week (may include partials,
   `early` when partials carry >50% weight); `prevMedian` is the last *closed* week (complete + backfill only).
   Plain numbers only: no cut flagging. Engine: `engine crowd`.
3. **Not done.** Re-hash `readings[].account` and `readings[].req` on ingest with `GOTCAPPED_INGEST_SECRET` before they are stored, and backfill rows already stored under the public pepper. The request body does not change, so old clients keep working and request de-dup keeps matching. Spec, rollout order, and privacy wording: [INGEST_REKEY.md](INGEST_REKEY.md). Reference: `gotcapped-cli/src/shared/ingest-rekey.ts`.
