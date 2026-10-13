// Claude Code. Tokens: ~/.claude/projects/**/*.jsonl (and ~/.config/claude, $CLAUDE_CONFIG_DIR). Only allow-listed keys
// are read: timestamp, requestId, message.id, message.model, message.usage.*. Message content is never touched.
// Bar %: the optional statusline hook (Claude Code passes rate_limits to statusline stdin) appends to ~/.gotcapped/bars.jsonl.
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { accountKey, reqHash, readJson, userHome, walk, toMs } from "./util";

export type Entry = { t: number; m: string; in: number; out: number; cr: number; cw: number; cw1h: number; req: string };
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
  if (/team|enterprise/.test(type) || o.seatTier) { seat = `${/enterprise/.test(type) ? "enterprise" : "team"}_${String(o.seatTier || "standard").toLowerCase()}`.replace(/[^\w-]/g, "_"); }
  else if (/max/.test(type) || /max/.test(tier)) { plan = /20x/.test(tier) ? "claude-max-20x" : /5x/.test(tier) ? "claude-max-5x" : undefined; seat = plan ? plan.replace("claude-", "personal_").replace(/-/g, "") : "personal_max"; }
  else if (/pro/.test(type)) { plan = "claude-pro"; seat = "personal_pro"; }
  return { account: accountKey("claude", o.accountUuid, o.organizationUuid || ""), plan, seat };
}

export function parseClaudeLine(line: string): Entry | null {
  if (!line.includes('"usage"')) return null;
  let d: any; try { d = JSON.parse(line); } catch { return null; }
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
export function scanClaude(dir: string, since: number): Entry[] {
  const seen = new Set<string>(), out: Entry[] = [];
  for (const f of walk(join(dir, "projects"), /\.jsonl$/)) {
    let txt; try { txt = readFileSync(f, "utf8"); } catch { continue; }
    for (const line of txt.split("\n")) { const e = parseClaudeLine(line); if (!e || e.t < since || seen.has(e.req)) continue; seen.add(e.req); out.push(e); }
  }
  return out.sort((a, b) => a.t - b.t);
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
