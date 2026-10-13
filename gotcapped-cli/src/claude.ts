// Claude Code. Tokens: ~/.claude/projects/**/*.jsonl (and ~/.config/claude, $CLAUDE_CONFIG_DIR). Only allow-listed keys
// are read: timestamp, requestId, message.id, message.model, message.usage.*. Message content is never touched.
// Bar %: the optional statusline hook (Claude Code passes rate_limits to statusline stdin) appends to ~/.gotcapped/bars.jsonl.
import { readFileSync, existsSync, readdirSync } from "fs";
import { join, basename } from "path";
import { accountKey, reqHash, readJson, userHome, walk, toMs } from "./util";
import { scanIncremental, cachePath } from "./incr";

export type Entry = { t: number; m: string; in: number; out: number; cr: number; cw: number; cw1h: number; req: string; s?: string };
export type Bar = { t: number; account: string | null; dir: string; kind: "5h" | "weekly"; pct: number; reset: number; source: "statusline" | "rpc" | "rollout" | "manual"; windowMins?: number };
export type AccountInfo = { account: string | null; plan?: string; seat?: string };

export function claudeDirs(): string[] {
  const env = process.env.CLAUDE_CONFIG_DIR;
  const ds = env ? env.split(",").map((s) => s.trim()).filter(Boolean) : [join(userHome(), ".claude"), join(userHome(), ".config", "claude")];
  return ds.filter((d) => existsSync(join(d, "projects")));
}
// ~/.claude.json sits next to ~/.claude by default; with CLAUDE_CONFIG_DIR it sits inside that dir.
export const claudeAccountFile = (dir: string) => (process.env.CLAUDE_CONFIG_DIR ? join(dir, ".claude.json") : join(userHome(), ".claude.json"));

export function claudeAccount(dir: string): AccountInfo {
  const o = readJson(claudeAccountFile(dir))?.oauthAccount;
  if (!o?.accountUuid) return { account: null };
  const tier = String(o.userRateLimitTier || o.organizationRateLimitTier || "").toLowerCase(), type = String(o.organizationType || "").toLowerCase();
  let plan: string | undefined, seat: string | undefined;
  if (/team|enterprise/.test(type) || o.seatTier) {
    const ent = /enterprise/.test(type), st = String(o.seatTier || "").toLowerCase();
    seat = `${ent ? "enterprise" : "team"}_${st || "standard"}`.replace(/[^\w-]/g, "_");
    // Team premium/standard are known; an unlabelled seat stays unset so the user confirms it with one tap.
    if (!ent && /premium/.test(st)) plan = "claude-team-premium"; else if (!ent && /standard/.test(st)) plan = "claude-team-standard";
  }
  else if (/max/.test(type) || /max/.test(tier)) { plan = /20x/.test(tier) ? "claude-max-20x" : /5x/.test(tier) ? "claude-max-5x" : undefined; seat = plan ? plan.replace("claude-", "personal_").replace(/-/g, "") : "personal_max"; }
  else if (/pro/.test(type)) { plan = "claude-pro"; seat = "personal_pro"; }
  return { account: accountKey("claude", o.accountUuid, o.organizationUuid || ""), plan, seat };
}

// Fast path: pull only the allow-listed keys with anchored regexes so multi-MB message content is never JSON-parsed.
// Falls back to a full parse whenever any field is missing or ambiguous.
const RX = { type: /^\{[^]*?"type":"(assistant|user|summary|system)"/, ts: /"timestamp":"([^"]+)"/, req: /"requestId":"([^"]+)"/,
  mid: /"message":\{"id":"([^"]+)"/, model: /"message":\{[^{}]*?"model":"([^"]+)"/, usage: /"usage":(\{(?:[^{}]|\{[^{}]*\})*\})(?![^]*"usage":\{)/ };
function fastFields(line: string): any | null {
  const mid = RX.mid.exec(line), model = RX.model.exec(line), u = RX.usage.exec(line), ts = RX.ts.exec(line);
  if (!mid || !model || !u || !ts || !line.includes('"type":"assistant"')) return null;
  let usage: any; try { usage = JSON.parse(u[1]); } catch { return null; }
  const req = RX.req.exec(line);
  return { type: "assistant", timestamp: ts[1], requestId: req ? req[1] : undefined, message: { id: mid[1], model: model[1], usage } };
}
export function parseClaudeLine(line: string): Entry | null {
  if (!line.includes('"usage"')) return null;
  let d: any = line.length > 4096 ? fastFields(line) : null;
  if (!d) { try { d = JSON.parse(line); } catch { return null; } }
  const m = d?.message, u = m?.usage; if (d?.type !== "assistant" || !u || typeof m.model !== "string" || m.model === "<synthetic>") return null;
  const t = toMs(d.timestamp); if (!t) return null;
  const n = (v: any) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
  const cwTotal = n(u.cache_creation_input_tokens);
  const c = u.cache_creation && typeof u.cache_creation === "object" ? u.cache_creation : null;
  const cw1h = c ? Math.min(cwTotal, n(c.ephemeral_1h_input_tokens)) : 0;
  const e = { t, m: m.model, in: n(u.input_tokens), out: n(u.output_tokens), cr: n(u.cache_read_input_tokens), cw: cwTotal - cw1h, cw1h, req: reqHash("claude", `${m.id ?? ""}:${d.requestId ?? ""}`) };
  return e.in + e.out + e.cr + e.cw + e.cw1h > 0 ? e : null;
}

// Deduped by message id + request id (Claude Code repeats lines across resumed sessions), like ccusage.
// Streams only files modified since `since`, newest first, with a per-file offset cache (see incr.ts).
export function scanClaude(dir: string, since: number, opt: { cache?: boolean; save?: boolean; budgetMs?: number } = {}): Entry[] & { complete?: boolean } {
  // s = session id (the transcript file name), so a session can be tied to the account that ran it (see claudeSessionOwners).
  const r = scanIncremental<Entry, string>({ files: walk(join(dir, "projects"), /\.jsonl$/), since, cacheFile: opt.cache === false ? null : cachePath("claude-s", dir), save: opt.save,
    marks: ['"usage"'], fresh: (f) => basename(f, ".jsonl"), budgetMs: opt.budgetMs, parse: (l, sid, out) => { const e = parseClaudeLine(l); if (e) { e.s = sid; out.push(e); } } });
  const seen = new Set<string>(), out: Entry[] & { complete?: boolean } = [];
  for (const e of r.entries) { if (e.t < since || seen.has(e.req)) continue; seen.add(e.req); out.push(e); }
  out.sort((a, b) => a.t - b.t); out.complete = r.complete; return out;
}

// Statusline stdin → bar readings. Accepts used_percentage (documented) and utilization; resets_at as epoch s/ms or ISO.
export function barsFromStatusline(input: any, account: string | null, dir: string, t = Date.now()): Bar[] {
  const rl = input?.rate_limits; if (!rl || typeof rl !== "object") return [];
  const out: Bar[] = [];
  for (const [k, kind] of [["five_hour", "5h"], ["seven_day", "weekly"]] as const) {
    const x = rl[k]; if (!x) continue;
    const pct = Number(x.used_percentage ?? x.utilization ?? x.used_percent), reset = toMs(x.resets_at);
    if (isFinite(pct) && pct >= 0 && pct <= 100 && reset) out.push({ t, account, dir, kind, pct, reset, source: "statusline" });
  }
  return out;
}
export function loadBars(file: string): Bar[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// Claude desktop app (macOS). Its built-in Claude Code signs in on its own (token kept by the app, never read here) and can be a
// different account from the `claude` CLI, yet it writes transcripts to the same ~/.claude/projects. ~/.claude.json only describes
// the CLI login, so without this every desktop-app token would be charged to the CLI account and plan.
// The app keeps one folder per signed-in account and org: claude-code-sessions/<accountUuid>/<orgUuid>/local_*.json, each naming
// the transcript it drives ("cliSessionId"). Only that one key is read, by regex; nothing else in those files is parsed or kept.
export const claudeAppDir = () => process.env.GOTCAPPED_CLAUDE_APP_DIR || join(userHome(), "Library", "Application Support", "Claude");
export type DesktopAccount = { account: string; sessions: string[]; last: number };
export function claudeDesktopAccounts(): DesktopAccount[] {
  const root = join(claudeAppDir(), "claude-code-sessions"); if (!existsSync(root)) return [];
  const out: DesktopAccount[] = [], ls = (d: string) => { try { return readdirSync(d); } catch { return []; } };
  for (const acct of ls(root)) for (const org of ls(join(root, acct))) {
    const d = join(root, acct, org), sessions: string[] = []; let last = 0;
    for (const f of ls(d)) { if (!/^local_.*\.json$/.test(f)) continue;
      try { const t = readFileSync(join(d, f), "utf8"), m = /"cliSessionId"\s*:\s*"([\w-]+)"/.exec(t), a = /"lastActivityAt"\s*:\s*(\d+)/.exec(t);
        if (m) sessions.push(m[1]); if (a) last = Math.max(last, Number(a[1])); } catch {} }
    if (sessions.length) out.push({ account: accountKey("claude", acct, org), sessions, last });
  }
  return out.sort((a, b) => b.last - a.last);
}
// session id -> account key, for sessions the desktop app ran. CLI sessions are not listed and fall back to the timeline.
export function claudeSessionOwners(): Map<string, string> { const m = new Map<string, string>(); for (const a of claudeDesktopAccounts()) for (const s of a.sessions) m.set(s, a.account); return m; }
