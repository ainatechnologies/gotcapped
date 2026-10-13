// Tray engine: a thin, non-interactive JSON front-end over the SAME modules as the `gotcapped` CLI
// (../gotcapped-cli/src). No parsing, pricing, attribution or payload logic lives here: one engine, two shells.
// The Tauri app runs this as a sidecar binary and reads one JSON document from stdout.
//   engine scan            -> { accounts, readings(local view), skipped, payload, preview }
//   engine sample          -> records which account is active in each config dir (switch detection, §17.2)
//   engine send            -> POSTs the current payload to /api/ingest, returns the server's crowd answer
//   engine cursor <csv>    -> prices a Cursor usage CSV locally (never sent in v0)
//   engine forget          -> deletes ~/.gotcapped (all local state), shared with the CLI
//   engine delete-all      -> DELETE /api/ingest (device secret) then forget; keeps local state if the server fails
//   engine crowd           -> GET /api/ingest/crowd (this week + last closed week medians, counts) into tray-crowd.json
//   engine set-plan <account> <plan>
import { join } from "path";
import { readFileSync, writeFileSync, existsSync, rmSync } from "fs";
import { VERSION, home, ensureDir, loadState, saveState, sample, appendLine, userHome, type State } from "../../gotcapped-cli/src/util";
import { claudeDirs, claudeAccount, scanClaude, loadBars, barsFromStatusline, claudeDesktopAccounts, claudeSessionOwners } from "../../gotcapped-cli/src/claude";
import { codexHome, codexAccount, scanCodex, codexRpcLimits, barsFromRateLimits, codexInstalled, CODEX_PLAN } from "../../gotcapped-cli/src/codex";
import { buildReading, latestBars, previewOf, type Local } from "../../gotcapped-cli/src/build";
import { attributor } from "../../gotcapped-cli/src/attrib";
import { parseUsage } from "../../gotcapped-cli/src/shared/parse";
import { priceUsage } from "../../gotcapped-cli/src/shared/prices";
import { proofOf } from "../../gotcapped-cli/src/util";
import { deleteRemote, fetchCrowd } from "../../gotcapped-cli/src/remote";

export const ENGINE_VERSION = `tray-0.1.0+cli-${VERSION}`;
const ENDPOINT = process.env.GOTCAPPED_ENDPOINT || "https://www.gotcapped.com/api/ingest";
const barsFile = () => join(home(), "bars.jsonl");
const crowdFile = () => join(home(), "tray-crowd.json");
export const PLAN_NAMES: Record<string, string> = { "claude-pro": "Claude Pro", "claude-max-5x": "Claude Max 5x", "claude-max-20x": "Claude Max 20x", "chatgpt-plus": "ChatGPT Plus", "chatgpt-pro-100": "ChatGPT Pro $100", "chatgpt-pro-200": "ChatGPT Pro $200", "claude-team-standard": "Claude Team Standard", "claude-team-premium": "Claude Team Premium" };
export const LOCAL_ONLY = /^claude-team-/;
export const PLAN_PRICE: Record<string, number> = { "claude-pro": 20, "claude-max-5x": 100, "claude-max-20x": 200, "chatgpt-plus": 20, "chatgpt-pro-100": 100, "chatgpt-pro-200": 200 };

export type Account = { vendor: "claude" | "codex"; account: string; short: string; dir: string; plan: string | null; planName: string | null; seat?: string; tool: string; login: string; signedIn: boolean };
export type View = { vendor: string; account: string; plan: string; planName: string; kind: "5h" | "weekly"; pct: number; source: string; resetAt: string; usd: number; perBar: number | null; tokens: number; tk?: { in: number; out: number; cr: number; cw: number }; note?: string; attribution: string; crowd?: { median: number | null; n: number; need: number; early?: boolean; prevMedian?: number | null; prevN?: number } | null; planPrice?: number };

type Opt = { quick?: boolean; accountsOnly?: boolean };
// quick: only the current 5-hour window (newest files, cache read-only) so the popover gets a first number in seconds.
const kinds = (o: Opt) => (o.quick ? ["5h"] : ["5h", "weekly"]);
function collect(s: State, o: Opt = {}) {
  const now = Date.now(), since = now - (o.quick ? 5 * 36e5 + 6e4 : 8 * 864e5), locals: Local[] = [], skipped: string[] = [], accounts: Account[] = [];
  const owners = claudeSessionOwners(), desk = claudeDesktopAccounts(); let appSessions = 0;
  for (const [i, dir] of claudeDirs().entries()) {
    const cli = claudeAccount(dir); sample(s, "claude", dir, cli.account, now);
    // Only the `claude` CLI login in ~/.claude.json is measured. The Claude desktop app signs in separately and leaves no
    // readable plan or usage bar, so its sessions are excluded (via `owners`) instead of being counted against this login.
    const list = [{ ...cli, tool: "Claude Code" }];
    if (i === 0) appSessions = desk.filter((d) => d.account !== cli.account).reduce((a, d) => a + d.sessions.length, 0);
    let entries: ReturnType<typeof scanClaude> | null = null;
    for (const acc of list) {
    if (!acc.account) { skipped.push("Claude Code: found, but not signed in to a subscription."); continue; }
    const plan = s.plans[acc.account] ?? acc.plan ?? null; if (plan && !s.plans[acc.account]) s.plans[acc.account] = plan;
    accounts.push({ vendor: "claude", account: acc.account, short: acc.account.slice(0, 8), dir, plan, planName: plan ? PLAN_NAMES[plan] ?? plan : null, seat: acc.seat, tool: acc.tool, login: process.env.CLAUDE_CONFIG_DIR ? `claude CLI login (${dir}/.claude.json)` : "claude CLI login (~/.claude.json)", signedIn: true });
    if (!plan) { skipped.push(`${acc.tool} ${acc.account.slice(0, 8)}${acc.seat ? ` (detected: ${acc.seat.replace(/_/g, " ")})` : ""}: confirm your plan to measure it.`); continue; }
    if (o.accountsOnly) continue;
    entries ??= scanClaude(dir, since, { save: !o.quick });
    const bars = latestBars(loadBars(barsFile()).filter((b) => b.dir === dir), now).filter((b) => b.account === acc.account && kinds(o).includes(b.kind));
    if (!bars.length) skipped.push(`${acc.tool} ${acc.account.slice(0, 8)}: no bar % yet. Turn on the Claude Code status line hook in Settings.`);
    for (const b of bars) locals.push(buildReading({ vendor: "claude", plan, seat: acc.seat, bar: b, entries, timeline: s.timeline, owners }));
    }
  }
  return { now, locals, skipped, accounts, appSessions };
}

async function collectCodex(s: State, out: ReturnType<typeof collect>, o: Opt = {}) {
  if (!codexInstalled()) return;
  const dir = codexHome(), acc = codexAccount(dir); sample(s, "codex", dir, acc.account, out.now);
  if (!acc.account) { out.skipped.push("Codex: found, but not signed in with ChatGPT."); return; }
  const rpc = process.env.GOTCAPPED_NO_RPC || o.accountsOnly ? null : await codexRpcLimits(8000);
  const planType = rpc?.planType || acc.planType;
  const plan = s.plans[acc.account] ?? (planType ? CODEX_PLAN[planType] : undefined) ?? null; if (plan && !s.plans[acc.account]) s.plans[acc.account] = plan;
  out.accounts.push({ vendor: "codex", account: acc.account, short: acc.account.slice(0, 8), dir, plan, planName: plan ? PLAN_NAMES[plan] ?? plan : null, seat: acc.seat, tool: "Codex", login: "Codex login (~/.codex/auth.json)", signedIn: true });
  if (!plan) { out.skipped.push(`Codex ${acc.account.slice(0, 8)} (${planType ?? "unknown plan"}): pick a plan to measure it.`); return; }
  if (o.accountsOnly) return;
  const scan = scanCodex(dir, out.now - (o.quick ? 5 * 36e5 + 6e4 : 8 * 864e5), { save: !o.quick }), who = attributor(s.timeline, "codex", dir);
  const fromLogs = scan.bars.map((b) => ({ ...b, dir, account: who(b.t).how === "ambiguous" ? null : who(b.t).account }));
  const fromRpc = rpc ? barsFromRateLimits(rpc.rateLimits, out.now, acc.account, dir, "rpc") : [];
  const bars = latestBars([...fromLogs, ...fromRpc], out.now).filter((b) => b.account === acc.account && kinds(o).includes(b.kind));
  if (!bars.length) out.skipped.push(`Codex ${acc.account.slice(0, 8)}: no bar % yet (Codex reports it after your next prompt).`);
  for (const b of bars) out.locals.push(buildReading({ vendor: "codex", plan, seat: acc.seat, bar: b, entries: scan.entries, timeline: s.timeline }));
}

const readCrowd = (): Record<string, any> => { try { return JSON.parse(readFileSync(crowdFile(), "utf8")); } catch { return {}; } };

export async function scan(o: Opt = {}) {
  const s = loadState();
  const out = collect(s, o); await collectCodex(s, out, o); saveState(s);
  const crowd = readCrowd();
  const views: View[] = out.locals.map((l) => ({
    vendor: l.reading.vendor, account: l.reading.account, plan: l.reading.plan, planName: PLAN_NAMES[l.reading.plan] ?? l.reading.plan, kind: l.reading.kind,
    pct: l.reading.bar.pct, source: l.reading.bar.source, resetAt: l.reading.reset_at, usd: l.usd, perBar: l.perBar, tokens: l.tokens, note: l.note,
    tk: l.reading.usage.reduce((a, u: any) => ({ in: a.in + u.in, out: a.out + u.out, cr: a.cr + u.cr, cw: a.cw + u.cw + (u.cw1h ?? 0) }), { in: 0, out: 0, cr: 0, cw: 0 }),
    attribution: l.reading.attribution, crowd: crowd[`${l.reading.plan}|${l.reading.kind}`] ?? null, planPrice: PLAN_PRICE[l.reading.plan],
  }));
  const sendable = out.locals.filter((l) => l.reading.usage.length && !LOCAL_ONLY.test(l.reading.plan)); // Team seats: measured locally, never sent (yet)
  const payload = { v: 1 as const, client: VERSION, device: s.device, proof: proofOf(s.secret), readings: sendable.map((l) => l.reading) };
  if (!o.quick && !o.accountsOnly) { ensureDir(join(home(), "outbox")); writeFileSync(join(home(), "outbox", "last.json"), JSON.stringify(payload, null, 2), { mode: 0o600 }); }
  return { ok: true, phase: o.accountsOnly ? "accounts" : o.quick ? "quick" : "full", engine: ENGINE_VERSION, at: new Date(out.now).toISOString(), device: s.device.slice(0, 8), accounts: out.accounts, appSessions: out.appSessions, readings: views, skipped: out.skipped, payload, preview: previewOf(payload), hookInstalled: hookInstalled() };
}

function hookInstalled() { for (const d of [...claudeDirs(), join(process.env.HOME || "", ".claude")]) { try { const c = JSON.parse(readFileSync(join(d, "settings.json"), "utf8")); if (String(c?.statusLine?.command || "").includes("gotcapped") || String(c?.statusLine?.command || "").includes("gc-engine")) return true; } catch {} } return false; }

export function sampleOnly() {
  const s = loadState(), now = Date.now(), seen: any[] = [];
  for (const d of claudeDirs()) { const a = claudeAccount(d).account; sample(s, "claude", d, a, now); seen.push({ vendor: "claude", account: a?.slice(0, 8) ?? null }); }
  if (codexInstalled()) { const a = codexAccount().account; sample(s, "codex", codexHome(), a, now); seen.push({ vendor: "codex", account: a?.slice(0, 8) ?? null }); }
  saveState(s); return { ok: true, seen };
}

export async function send() {
  const r = await scan();
  if (!r.payload.readings.length) return { ok: true, sent: 0, crowd: [] };
  const res = await fetch(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", "user-agent": `gotcapped-tray/${ENGINE_VERSION}` }, body: JSON.stringify(r.payload) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) return { ok: false, error: j.error || `HTTP ${res.status}` };
  await crowd().catch(() => null); // refresh medians after sending
  return { ok: true, sent: r.payload.readings.length, crowd: j.crowd ?? [] };
}

export function cursorCsv(path: string) {
  const p = parseUsage(readFileSync(path, "utf8"));
  if (p.source !== "Cursor usage CSV") return { ok: false, error: "That file doesn't look like a Cursor usage export (Dashboard → Usage → Export CSV)." };
  const usage = (p.rows ?? []).flatMap((r: any) => r.usage), priced = priceUsage(usage);
  const t = (p.rows ?? []).map((r: any) => r.t0); const toolUsd = (p.rows ?? []).reduce((a: number, r: any) => a + (r.toolUsd ?? 0), 0);
  const v = { ok: true, rows: p.rows?.length ?? 0, from: new Date(Math.min(...t)).toISOString(), to: new Date(Math.max(...t)).toISOString(), usd: priced.usd, cursorSaid: toolUsd, unpriced: priced.unpriced, notes: p.notes, localOnly: true };
  writeFileSync(join(ensureDir(home()), "tray-cursor.json"), JSON.stringify(v), { mode: 0o600 });
  return v;
}
export const cursorLast = () => { try { return JSON.parse(readFileSync(join(home(), "tray-cursor.json"), "utf8")); } catch { return null; } };

export function setPlan(account: string, plan: string) { const s = loadState(); const full = Object.keys(s.plans).concat(s.timeline.map((x) => x.account || "")).find((a) => a.startsWith(account)) || account; if (plan === "none") delete s.plans[full]; else s.plans[full] = plan; saveState(s); return { ok: true }; }
// GET /api/ingest/crowd for both window kinds; cached locally so the tray shows this week vs last week without sending.
export async function crowd() {
  const c = readCrowd(), ua = `gotcapped-tray/${ENGINE_VERSION}`;
  for (const kind of ["weekly", "5h"] as const) for (const x of await fetchCrowd(ENDPOINT, kind, ua)) c[`${x.plan}|${x.kind}`] = { median: x.median, n: x.n, need: x.need, early: x.early, prevMedian: x.prevMedian, prevN: x.prevN, at: Date.now() };
  ensureDir(home()); writeFileSync(crowdFile(), JSON.stringify(c), { mode: 0o600 });
  return { ok: true, plans: Object.keys(c).length };
}
// Server-side deletion (needs this install's device secret), then local. Local state is kept if the server call fails.
export async function deleteAll() {
  const s = loadState();
  if (!existsSync(join(home(), "state.json"))) { forget(); return { ok: true, server: "none", message: "Nothing was ever sent from this device." }; }
  const r = await deleteRemote(ENDPOINT, s, `gotcapped-tray/${ENGINE_VERSION}`).catch((e) => ({ ok: false, status: 0, deleted: 0, error: String(e?.message || e) }));
  if (r.ok || r.status === 404) { forget(); return { ok: true, server: r.ok ? "deleted" : "none", deleted: r.deleted, message: r.ok ? `Server copy deleted (${r.deleted} readings).` : "Nothing stored on the server for this device." }; }
  return { ok: false, server: "failed", status: r.status, error: r.error, message: `Server deletion failed (${r.status || "offline"}: ${r.error}). Local data kept so you can retry.` };
}
export function forget() { const h = home(); if (existsSync(h)) rmSync(h, { recursive: true, force: true }); return { ok: true, deleted: h }; }

// Claude Code status line hook, same behaviour and file format as `gotcapped hook statusline` in the CLI.
async function hookStatusline(then?: string) {
  const chunks: Buffer[] = []; for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8"); let input: any = {}; try { input = JSON.parse(raw); } catch {}
  const dir = process.env.CLAUDE_CONFIG_DIR?.split(",")[0] || claudeDirs()[0] || join(userHome(), ".claude");
  // A status line from a Claude desktop app session belongs to the app's sign-in, not to the CLI login in ~/.claude.json.
  const own = claudeSessionOwners().get(String(input?.session_id ?? "")), acc = own ?? claudeAccount(dir).account;
  if (!own) { const s = loadState(); sample(s, "claude", dir, acc); saveState(s); }
  const bars = barsFromStatusline(input, acc, dir), prev = latestBars(loadBars(barsFile()).filter((b) => b.account === acc), Date.now());
  for (const b of bars) { const p = prev.find((x) => x.kind === b.kind && Math.abs(x.reset - b.reset) < 6e4); if (!p || p.pct !== b.pct || b.t - p.t > 10 * 6e4) appendLine(barsFile(), b); }
  if (then) { const { spawnSync } = await import("child_process"); const r = spawnSync(then, { shell: true, input: raw, encoding: "utf8" }); process.stdout.write(r.stdout || ""); return true; }
  const w = bars.find((b) => b.kind === "weekly"), h = bars.find((b) => b.kind === "5h");
  process.stdout.write(`${input?.model?.display_name ?? "Claude"}${h ? ` · 5h ${Math.round(h.pct)}%` : ""}${w ? ` · week ${Math.round(w.pct)}%` : ""} · gotcapped`); return true;
}
// Points Claude Code's statusLine at this engine binary; an existing status line keeps running via --then. Backs up settings.json.
export function installHook(engineBin: string) {
  const dir = claudeDirs()[0] || join(userHome(), ".claude"), f = join(dir, "settings.json");
  let cur: any = {}; try { cur = JSON.parse(readFileSync(f, "utf8")); } catch {}
  const existing = cur.statusLine?.command as string | undefined;
  if (existing?.includes("gotcapped") || existing?.includes("gc-engine")) return { ok: true, already: true };
  const self = JSON.stringify(engineBin);
  const cmd = existing ? `${self} hook-statusline --then ${JSON.stringify(existing)}` : `${self} hook-statusline`;
  if (existsSync(f)) writeFileSync(f + ".gotcapped-backup", readFileSync(f));
  cur.statusLine = { type: "command", command: cmd + " # gotcapped" }; ensureDir(dir); writeFileSync(f, JSON.stringify(cur, null, 2));
  return { ok: true, file: f };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  let r: any;
  try {
    if (cmd === "scan") r = { ...(await scan({ quick: rest.includes("--quick"), accountsOnly: rest.includes("--accounts") })), cursor: cursorLast() };
    else if (cmd === "sample") r = sampleOnly();
    else if (cmd === "send") r = await send();
    else if (cmd === "cursor") r = cursorCsv(rest[0]);
    else if (cmd === "set-plan") r = setPlan(rest[0], rest[1]);
    else if (cmd === "forget") r = forget();
    else if (cmd === "delete-all") r = await deleteAll();
    else if (cmd === "crowd") r = await crowd();
    else if (cmd === "hook-statusline") { const i = rest.indexOf("--then"); await hookStatusline(i >= 0 ? rest[i + 1] : undefined); return; }
    else if (cmd === "install-hook") r = installHook(process.execPath);
    else if (cmd === "version") r = { ok: true, engine: ENGINE_VERSION };
    else r = { ok: false, error: "usage: engine scan|sample|send|crowd|cursor <csv>|set-plan <acct> <plan>|forget|delete-all|version" };
  } catch (e: any) { r = { ok: false, error: String(e?.message || e) }; }
  process.stdout.write(JSON.stringify(r));
}
if (require.main === module) main();
