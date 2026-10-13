#!/usr/bin/env node
// gotcapped: measure how much API value your AI plan's bar is worth. Numbers only; nothing is sent without a yes.
import { createInterface } from "readline";
import { join } from "path";
import { existsSync, readFileSync, writeFileSync, rmSync } from "fs";
import { VERSION, home, ensureDir, loadState, saveState, sample, appendLine, userHome, type State } from "./util";
import { claudeDirs, claudeAccount, scanClaude, loadBars, barsFromStatusline, claudeSessionOwners, type Bar, type Entry } from "./claude";
import { codexHome, codexAccount, scanCodex, codexRpcLimits, barsFromRateLimits, codexInstalled, CODEX_PLAN } from "./codex";
import { buildReading, latestBars, previewOf, WINDOW_MS, type Local } from "./build";
import { attributor } from "./attrib";
import { parseReset } from "./shared/parse";
import { proofOf } from "./util";
import { deleteRemote } from "./remote";

const DEFAULT_ENDPOINT = "https://www.gotcapped.com/api/ingest";
const PLAN_NAMES: Record<string, string> = { "claude-pro": "Claude Pro", "claude-max-5x": "Claude Max 5x", "claude-max-20x": "Claude Max 20x", "chatgpt-plus": "ChatGPT Plus", "chatgpt-pro-100": "ChatGPT Pro $100", "chatgpt-pro-200": "ChatGPT Pro $200" };
const VENDOR_PLANS = { claude: ["claude-pro", "claude-max-5x", "claude-max-20x"], codex: ["chatgpt-plus", "chatgpt-pro-100", "chatgpt-pro-200"] };
const barsFile = () => join(home(), "bars.jsonl");
const money = (v: number | null) => (v == null || !isFinite(v) ? "–" : v >= 100 ? `$${Math.round(v).toLocaleString("en-US")}` : `$${v.toFixed(2)}`);
const fmtN = (v: number) => (v >= 1e9 ? (v / 1e9).toFixed(1) + "B" : v >= 1e6 ? (v / 1e6).toFixed(1) + "M" : v >= 1e3 ? Math.round(v / 1e3) + "k" : String(v));

type Opts = { dryRun: boolean; yes: boolean; json: boolean; watch: boolean; prompt: boolean; endpoint: string; plans: Record<string, string>; full: boolean };
function args(argv: string[]): Opts & { cmd: string[] } {
  const o: any = { dryRun: false, yes: false, json: false, watch: false, prompt: true, full: false, endpoint: process.env.GOTCAPPED_ENDPOINT || DEFAULT_ENDPOINT, plans: {}, cmd: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--dry-run") o.dryRun = true; else if (a === "--yes" || a === "-y") o.yes = true; else if (a === "--json") o.json = true;
    else if (a === "--watch") o.watch = true; else if (a === "--no-prompt") o.prompt = false; else if (a === "--full") o.full = true;
    else if (a === "--endpoint") o.endpoint = argv[++i];
    else if (a === "--plan") for (const kv of String(argv[++i] || "").split(",")) { const [k, v] = kv.split("="); if (k && v) o.plans[k.trim()] = v.trim(); }
    else if (a === "--help" || a === "-h") o.cmd = ["help"]; else if (a === "--version" || a === "-v") o.cmd = ["version"];
    else o.cmd.push(a);
  }
  return o;
}

let rl: ReturnType<typeof createInterface> | null = null;
const interactive = () => !!process.stdin.isTTY && !!process.stdout.isTTY;
function ask(q: string): Promise<string> { rl ??= createInterface({ input: process.stdin, output: process.stdout }); return new Promise((r) => rl!.question(q, (a) => r(a.trim()))); }
const closeRl = () => { rl?.close(); rl = null; };

async function choosePlan(s: State, o: Opts, vendor: "claude" | "codex", account: string, detected?: string): Promise<string | null> {
  if (o.plans[vendor]) return o.plans[vendor];
  if (s.plans[account]) return s.plans[account];
  if (!o.prompt || !interactive()) { if (detected) s.plans[account] = detected; return detected ?? null; }
  const opts = VENDOR_PLANS[vendor];
  console.log(`\nWhich plan is ${vendor === "claude" ? "Claude Code" : "Codex"} account ${account.slice(0, 8)} on?${detected ? ` (we detected ${PLAN_NAMES[detected]})` : ""}`);
  opts.forEach((p, i) => console.log(`  ${i + 1}. ${PLAN_NAMES[p]}`)); console.log("  0. Something else / a Team seat (keep it local)");
  const a = await ask(`Pick 0-${opts.length}${detected ? ` [Enter = ${PLAN_NAMES[detected]}]` : ""}: `);
  const pick = a === "" && detected ? detected : opts[Number(a) - 1] ?? null;
  if (pick) s.plans[account] = pick;
  return pick;
}

// One-time manual reading when no automatic bar source exists. Stored locally and reused until that window resets.
async function askBar(s: State, o: Opts, vendor: "claude" | "codex", account: string, dir: string): Promise<Bar[]> {
  const now = Date.now();
  const have = s.manual.filter((m) => m.vendor === vendor && m.account === account && m.reset_at > now - 7 * 864e5);
  if (have.length) return have.map((m) => ({ t: m.read_at, account, dir, kind: m.kind, pct: m.pct, reset: m.reset_at, source: "manual" as const }));
  if (!o.prompt || !interactive()) return [];
  const where = vendor === "claude" ? "run /usage in Claude Code and look at \"Current week (all models)\"" : "run /status in Codex and look at the weekly limit";
  console.log(`\nNo automatic bar reading yet for this ${vendor === "claude" ? "Claude" : "Codex"} account. To read it once: ${where}.`);
  const pct = Number((await ask("  % used this week (blank to skip): ")).replace("%", ""));
  if (!isFinite(pct) || pct <= 0 || pct > 100) return [];
  const r = parseReset(await ask("  Resets (e.g. \"Thu 10:00\", \"in 3d 4h\", \"Oct 16 9am\"): "), now);
  if (!r || r < now || r > now + 7 * 864e5) { console.log("  Couldn't read that reset time, skipping."); return []; }
  const m = { vendor, account, kind: "weekly" as const, pct, reset_at: r, read_at: now }; s.manual.push(m);
  return [{ t: now, account, dir, kind: "weekly", pct, reset: r, source: "manual" }];
}

async function collect(s: State, o: Opts): Promise<{ locals: Local[]; skipped: string[] }> {
  const now = Date.now(), since = now - 8 * 864e5, locals: Local[] = [], skipped: string[] = [];
  // Claude Code
  const owners = claudeSessionOwners();
  for (const dir of claudeDirs()) {
    const cli = claudeAccount(dir); sample(s, "claude", dir, cli.account, now);
    const entries = scanClaude(dir, since);
    // Only the CLI login in ~/.claude.json is measured. Claude desktop app sessions (a separate sign-in with no readable
    // plan or bar) are excluded via `owners` so their tokens never count against this login.
    for (const acc of [cli]) {
    if (!acc.account) { skipped.push(`Claude Code (${dir}): not signed in to a subscription, skipped.`); continue; }
    const plan = await choosePlan(s, o, "claude", acc.account, acc.plan);
    if (!plan) { skipped.push(`Claude Code account ${acc.account.slice(0, 8)}${acc.seat ? ` (${acc.seat})` : ""}: no public plan page for this seat yet, kept local.`); continue; }
    let bars = latestBars(loadBars(barsFile()).filter((b) => b.dir === dir), now).filter((b) => b.account === acc.account);
    if (!bars.some((b) => b.kind === "weekly")) bars = [...bars, ...latestBars(await askBar(s, o, "claude", acc.account, dir), now)];
    if (!bars.length) skipped.push(`Claude Code account ${acc.account.slice(0, 8)}: no bar reading. Run \`gotcapped install-hook\` (automatic) or run again to enter it.`);
    for (const b of bars) locals.push(buildReading({ vendor: "claude", plan, seat: acc.seat, bar: b, entries, timeline: s.timeline, owners }));
    }
  }
  // Codex
  if (codexInstalled()) {
    const dir = codexHome(), acc = codexAccount(dir); sample(s, "codex", dir, acc.account, now);
    const scan = scanCodex(dir, since);
    if (!acc.account) skipped.push("Codex: not signed in with ChatGPT, skipped.");
    else {
      const rpc = await codexRpcLimits();
      const planType = rpc?.planType || acc.planType;
      const plan = await choosePlan(s, o, "codex", acc.account, planType ? CODEX_PLAN[planType] : undefined);
      if (!plan) skipped.push(`Codex account ${acc.account.slice(0, 8)} (${planType ?? "unknown plan"}): no public plan page, kept local.`);
      else {
        const who = attributor(s.timeline, "codex", dir);
        const fromLogs = scan.bars.map((b) => ({ ...b, dir, account: who(b.t).how === "ambiguous" ? null : who(b.t).account }));
        const fromRpc = rpc ? barsFromRateLimits(rpc.rateLimits, now, acc.account, dir, "rpc") : [];
        let bars = latestBars([...fromLogs, ...fromRpc], now).filter((b) => b.account === acc.account);
        if (!bars.length) bars = latestBars(await askBar(s, o, "codex", acc.account, dir), now);
        if (!bars.length) skipped.push(`Codex account ${acc.account.slice(0, 8)}: no 5-hour or weekly bar reading found.`);
        for (const b of bars) locals.push(buildReading({ vendor: "codex", plan, seat: acc.seat, bar: b, entries: scan.entries, timeline: s.timeline }));
      }
    }
  }
  return { locals, skipped };
}

function summary(locals: Local[], skipped: string[]) {
  console.log(`\nCapped tracker ${VERSION}: your numbers, computed on this machine\n`);
  for (const l of locals) {
    const r = l.reading, win = r.kind === "weekly" ? "this week" : "this 5-hour session";
    console.log(`  ${PLAN_NAMES[r.plan] ?? r.plan} · account ${r.account.slice(0, 8)} · ${win}`);
    console.log(`    ${win[0].toUpperCase() + win.slice(1)} your ${PLAN_NAMES[r.plan]} gave ${money(l.usd)} of API value so far (${fmtN(l.tokens)} tokens).`);
    console.log(`    Bar at ${r.bar.pct}% (${r.bar.source}) → about ${money(l.perBar)} per full bar. Resets ${new Date(r.reset_at).toLocaleString()}.`);
    if (l.note) console.log(`    Note: ${l.note}`);
  }
  for (const s of skipped) console.log(`  · ${s}`);
  if (!locals.length) console.log("  Nothing to measure yet.");
}

async function send(endpoint: string, payload: any) {
  const res = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "user-agent": `gotcapped/${VERSION}` }, body: JSON.stringify(payload) });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

async function once(o: Opts, auto = false) {
  const s = loadState();
  const { locals, skipped } = await collect(s, o);
  saveState(s);
  if (!auto || o.json) summary(locals, skipped);
  const sendable = locals.filter((l) => l.reading.usage.length);
  if (!sendable.length) return;
  const payload = { v: 1 as const, client: VERSION, device: s.device, proof: proofOf(s.secret), readings: sendable.map((l) => l.reading) };
  ensureDir(join(home(), "outbox")); writeFileSync(join(home(), "outbox", "last.json"), JSON.stringify(payload, null, 2), { mode: 0o600 });
  if (!auto) {
    console.log("\nExactly what would be sent (numbers only: no prompts, code, file paths, session IDs, emails or raw account IDs):\n");
    console.log(JSON.stringify(o.full ? payload : previewOf(payload), null, 2));
    console.log(`\nFull payload saved to ${join(home(), "outbox", "last.json")}`);
  }
  if (o.dryRun) { console.log("\nDry run: nothing sent."); return; }
  if (!auto) console.log(`\nSending numbers only. What we collect and why: https://www.gotcapped.com/privacy (questions: hello@gotcapped.com). Use --dry-run to measure without sending.`);
  const r = await send(o.endpoint, payload);
  for (const c of r.crowd ?? []) console.log(`Sent ${PLAN_NAMES[c.plan] ?? c.plan} (${c.kind}): ${c.valid ? "counts toward the median" : `stored, not counted yet (${(c.flags || []).join(", ") || "see methodology"})`}. ${c.median != null ? `Crowd median ${money(c.median)} per full bar (n=${c.n}).` : `${c.need} more reports until this week's median shows.`}`);
  for (const x of r.results ?? []) if (x.status === "duplicate") console.log(`Skipped a duplicate of another device's logs for account ${x.account}.`);
}

async function watch(o: Opts) {
  const s = loadState();
  if (!o.dryRun && !s.autoSend) { s.autoSend = true; saveState(s); }
  await once({ ...o, yes: true });
  closeRl();
  console.log(`Watching. Sending hourly to ${o.endpoint}. Ctrl+C to stop. Turn off with \`gotcapped pause\`.`);
  // Sample which account is active every minute so switches are caught (§17.2).
  setInterval(() => { const st = loadState(); for (const d of claudeDirs()) sample(st, "claude", d, claudeAccount(d).account); if (codexInstalled()) sample(st, "codex", codexHome(), codexAccount().account); saveState(st); }, 6e4);
  setInterval(() => { if (!loadState().autoSend && !o.yes) return; once({ ...o, yes: true }, true).catch((e) => console.error("send failed:", e.message)); }, 36e5);
}

// Claude Code statusline hook: record bar % and the active account, then print a short status line.
async function hookStatusline(then?: string) {
  const chunks: Buffer[] = []; for await (const c of process.stdin) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8"); let input: any = {}; try { input = JSON.parse(raw); } catch {}
  const dir = process.env.CLAUDE_CONFIG_DIR?.split(",")[0] || claudeDirs()[0] || join(userHome(), ".claude");
  // A status line from a Claude desktop app session belongs to the app's sign-in, not to the CLI login in ~/.claude.json.
  const own = claudeSessionOwners().get(String(input?.session_id ?? "")), acc = own ?? claudeAccount(dir).account;
  if (!own) { const s = loadState(); sample(s, "claude", dir, acc); saveState(s); }
  const bars = barsFromStatusline(input, acc, dir);
  const prev = latestBars(loadBars(barsFile()).filter((b) => b.account === acc), Date.now());
  for (const b of bars) { const p = prev.find((x) => x.kind === b.kind && Math.abs(x.reset - b.reset) < 6e4); if (!p || p.pct !== b.pct || b.t - p.t > 10 * 6e4) appendLine(barsFile(), b); }
  if (then) { const { spawnSync } = await import("child_process"); const r = spawnSync(then, { shell: true, input: raw, encoding: "utf8" }); process.stdout.write(r.stdout || ""); return; }
  const w = bars.find((b) => b.kind === "weekly"), h = bars.find((b) => b.kind === "5h");
  process.stdout.write(`${input?.model?.display_name ?? "Claude"}${h ? ` · 5h ${Math.round(h.pct)}%` : ""}${w ? ` · week ${Math.round(w.pct)}%` : ""} · gotcapped`);
}

async function installHook(o: Opts) {
  const dir = claudeDirs()[0] || join(userHome(), ".claude"), f = join(dir, "settings.json");
  const cur = (existsSync(f) && JSON.parse(readFileSync(f, "utf8"))) || {};
  const self = `${process.execPath} ${JSON.stringify(require.main?.filename ?? __filename)}`;
  const existing = cur.statusLine?.command as string | undefined;
  if (existing?.includes("gotcapped") || existing?.includes("cli.js hook")) { console.log("Hook already installed."); return; }
  const cmd = existing ? `${self} hook statusline --then ${JSON.stringify(existing)}` : `${self} hook statusline`;
  console.log(`This adds a Claude Code status line that saves your bar % to ${barsFile()} (local only, no network).`);
  console.log(`${f}:\n  "statusLine": ${JSON.stringify({ type: "command", command: cmd })}${existing ? `\n  (your current status line keeps working: it runs after ours via --then)` : ""}`);
  if (!o.yes) { if (!interactive()) { console.log("Re-run with --yes to apply."); return; } if (!/^y/i.test(await ask("Apply? [y/N] "))) { console.log("Not changed."); return; } }
  if (existsSync(f)) writeFileSync(f + ".gotcapped-backup", readFileSync(f));
  cur.statusLine = { type: "command", command: cmd }; ensureDir(dir); writeFileSync(f, JSON.stringify(cur, null, 2));
  console.log("Installed. Restart Claude Code; readings start on the next prompt.");
}

const HELP = `gotcapped ${VERSION}: how much API value does your AI plan's bar actually buy?

Usage:
  npx gotcapped                 measure, show what would be sent, ask before sending
  npx gotcapped --dry-run       measure and preview only
  npx gotcapped --watch         re-send hourly
  npx gotcapped install-hook    add the Claude Code status-line hook (automatic bar %)
  npx gotcapped pause           stop automatic sending
  npx gotcapped forget          delete this device's readings on the server, then ~/.gotcapped (--local-only to skip the server)

Options: --yes  --json  --full (show every request hash)  --no-prompt
         --plan claude=claude-max-20x,codex=chatgpt-pro-200  --endpoint URL
Privacy: https://www.gotcapped.com/privacy · hello@gotcapped.com. Source: MIT.`;

// One-time first-run notice (consent wording v1). Bump CONSENT_VERSION when the text changes.
export const CONSENT_VERSION = 1;
const CONSENT_TEXT = `Capped shares anonymous usage numbers to build public, crowd-measured plan stats.

It reads only token counts and usage-bar % from your local Claude Code and Codex logs,
and sends: plan, reset window, bar %, tokens per model, app version, a random device ID
and hashed account keys. Never your prompts, code, file names, email or raw IP.

Run by AINA Technologies LLC (US). Data may be stored outside your country, kept up to
13 months, and published only as aggregates. You can delete it any time with
\`npx gotcapped forget\`. Details: gotcapped.com/privacy · hello@gotcapped.com
`;
const consentFile = () => join(home(), "consent.json");
const hasConsent = () => { try { return JSON.parse(readFileSync(consentFile(), "utf8")).version === CONSENT_VERSION; } catch { return false; } };
// Returns true when the user has agreed (now or before). `n`/Cancel: nothing is read, stored or sent.
async function ensureConsent(o: Opts): Promise<boolean> {
  if (hasConsent()) return true;
  if (!o.yes) {
    console.log(CONSENT_TEXT);
    if (!interactive()) { console.log("Not started. Re-run in a terminal to agree, or pass --yes to agree to the notice above."); return false; }
    const a = (await ask("Agree and start sharing? [Y = Agree / n = Cancel] ")).trim().toLowerCase();
    if (a !== "" && a !== "y" && a !== "yes") { console.log("Cancelled. Nothing was read, stored or sent."); return false; }
  }
  ensureDir(home()); writeFileSync(consentFile(), JSON.stringify({ version: CONSENT_VERSION, at: new Date().toISOString(), via: o.yes ? "--yes" : "prompt" }), { mode: 0o600 });
  return true;
}

export async function main(argv = process.argv.slice(2)) {
  const o = args(argv); const [c, ...rest] = o.cmd;
  try {
    if (c === "help") console.log(HELP);
    else if (c === "version") console.log(VERSION);
    else if (c === "hook" && rest[0] === "statusline") { const i = argv.indexOf("--then"); await hookStatusline(i >= 0 ? argv[i + 1] : undefined); }
    else if (c === "install-hook") { if (await ensureConsent(o)) await installHook(o); }
    else if (c === "pause") { const s = loadState(); s.autoSend = false; saveState(s); console.log("Automatic sending paused."); }
    else if (c === "forget") {
      // Server first (it needs this device's secret), then local. A failed server call is reported, never hidden.
      if (!argv.includes("--local-only") && existsSync(join(home(), "state.json"))) {
        const s = loadState();
        const r = await deleteRemote(o.endpoint, s).catch((e) => ({ ok: false, status: 0, deleted: 0, error: String(e.message) }));
        if (r.ok) console.log(`Server: deleted ${r.deleted} reading(s) from this device.`);
        else if (r.status === 404) console.log("Server: nothing stored for this device.");
        else { console.log(`Server deletion failed (${r.status || "offline"}: ${r.error}). Local data kept so you can retry; use --local-only to delete it anyway.`); process.exitCode = 1; return; }
      }
      rmSync(home(), { recursive: true, force: true }); console.log(`Deleted ${home()}.`);
    }
    else if (c) { console.log(HELP); process.exitCode = 2; }
    else if (!(await ensureConsent(o))) { process.exitCode = 1; }
    else if (o.watch) { await watch(o); return; }
    else await once(o);
  } catch (e: any) { console.error(`gotcapped: ${e.message}`); process.exitCode = 1; }
  closeRl();
}
if (require.main === module) main();
