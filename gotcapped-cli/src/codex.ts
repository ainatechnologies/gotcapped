// Codex CLI. Tokens: $CODEX_HOME/sessions/**/rollout-*.jsonl (+ archived_sessions). Only token_count events, the model from
// turn_context, the session id from session_meta and rate_limits are read. Bar %: `codex app-server` JSON-RPC
// account/rateLimits/read (current account), falling back to rate_limits stamped in the rollout, then a one-time prompt.
import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { spawn } from "child_process";
import { accountKey, reqHash, readJson, userHome, walk, toMs } from "./util";
import type { Entry, Bar, AccountInfo } from "./claude";

export const codexHome = () => process.env.CODEX_HOME || join(userHome(), ".codex");
const PLAN: Record<string, string> = { plus: "chatgpt-plus", pro: "chatgpt-pro-200" };

function jwtClaims(tok: any): any { try { return JSON.parse(Buffer.from(String(tok).split(".")[1], "base64url").toString("utf8")); } catch { return null; } }
export function codexAccount(dir = codexHome()): AccountInfo & { planType?: string } {
  const a = readJson(join(dir, "auth.json")); const t = a?.tokens;
  const c = jwtClaims(t?.id_token)?.["https://api.openai.com/auth"] ?? {};
  const id = t?.account_id || c.chatgpt_account_id; if (!id) return { account: null };
  const planType = String(c.chatgpt_plan_type || "").toLowerCase() || undefined;
  return { account: accountKey("codex", String(id)), planType, plan: planType ? PLAN[planType] : undefined, seat: planType ? `chatgpt_${planType}` : undefined };
}

const kindOf = (mins: number): "5h" | "weekly" | null => (mins === 300 ? "5h" : mins === 10080 ? "weekly" : null);
export function barsFromRateLimits(rl: any, t: number, account: string | null, dir: string, source: Bar["source"]): Bar[] {
  const out: Bar[] = [];
  for (const w of [rl?.primary, rl?.secondary]) {
    if (!w) continue;
    const mins = Number(w.window_minutes ?? w.windowDurationMins), pct = Number(w.used_percent ?? w.usedPercent), reset = toMs(w.resets_at ?? w.resetsAt);
    const kind = kindOf(mins);
    if (kind && isFinite(pct) && pct >= 0 && pct <= 100 && reset) out.push({ t, account, dir, kind, pct, reset, source, windowMins: mins });
  }
  return out;
}

const n = (v: any) => (typeof v === "number" && isFinite(v) && v > 0 ? v : 0);
export function parseRollout(txt: string, file = ""): { entries: Entry[]; bars: Omit<Bar, "account" | "dir">[] } {
  const entries: Entry[] = [], bars: Omit<Bar, "account" | "dir">[] = [];
  let model = "", session = file, prevTotal = -1, i = 0;
  for (const line of txt.split("\n")) {
    if (!line) continue;
    let d: any; try { d = JSON.parse(line); } catch { continue; }
    const p = d?.payload; if (!p) continue;
    if (d.type === "session_meta" && p.id) session = String(p.id);
    if (d.type === "turn_context" && typeof p.model === "string") model = p.model;
    if (d.type !== "event_msg" || p.type !== "token_count") continue;
    const t = toMs(d.timestamp); if (!t) continue;
    if (p.rate_limits) for (const b of barsFromRateLimits(p.rate_limits, t, null, "", "rollout")) bars.push(b);
    const info = p.info; if (!info) continue;
    // Prefer the change in total_token_usage (robust to repeated events); fall back to last_token_usage.
    const tot = info.total_token_usage, last = info.last_token_usage;
    const totalNow = n(tot?.total_tokens);
    if (totalNow) { if (totalNow === prevTotal) continue; prevTotal = totalNow; }
    const u = last; if (!u) continue;
    const cached = n(u.cached_input_tokens), inp = Math.max(0, n(u.input_tokens) - cached);
    const e = { t, m: model || "gpt-5-codex", in: inp, out: n(u.output_tokens), cr: cached, cw: n(u.cache_write_input_tokens), cw1h: 0, req: reqHash("codex", `${session}:${totalNow || "i" + i++}:${t}`) };
    if (e.in + e.out + e.cr + e.cw > 0) entries.push(e);
  }
  return { entries, bars };
}
export function scanCodex(dir: string, since: number) {
  const seen = new Set<string>(), entries: Entry[] = [], bars: Omit<Bar, "account" | "dir">[] = [];
  const files = [...walk(join(dir, "sessions"), /^rollout-.*\.jsonl$/), ...walk(join(dir, "archived_sessions"), /^rollout-.*\.jsonl$/)];
  for (const f of files) {
    let txt; try { txt = readFileSync(f, "utf8"); } catch { continue; }
    const r = parseRollout(txt, f);
    for (const e of r.entries) if (e.t >= since && !seen.has(e.req)) { seen.add(e.req); entries.push(e); }
    bars.push(...r.bars.filter((b) => b.t >= since));
  }
  return { entries: entries.sort((a, b) => a.t - b.t), bars };
}

// Ask the local Codex app-server for the current account's rate limits. No network calls from us; Codex does its own.
export function codexRpcLimits(timeoutMs = 10000, bin = process.env.GOTCAPPED_CODEX_BIN || "codex"): Promise<{ rateLimits: any; planType?: string } | null> {
  return new Promise((resolve) => {
    let done = false, buf = "";
    const finish = (v: any) => { if (done) return; done = true; try { p.kill(); } catch {} resolve(v); };
    let p: ReturnType<typeof spawn>;
    try { p = spawn(bin, ["app-server"], { stdio: ["pipe", "pipe", "ignore"] }); } catch { return resolve(null); }
    p.on("error", () => finish(null)); p.on("exit", () => finish(null));
    const timer = setTimeout(() => finish(null), timeoutMs); timer.unref?.();
    p.stdout!.on("data", (c) => {
      buf += c; let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n"); p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" }) + "\n"); }
        if (m.id === 2) { clearTimeout(timer); const rl = m.result?.rateLimits; finish(rl ? { rateLimits: rl, planType: rl.planType ? String(rl.planType).toLowerCase() : undefined } : null); }
      }
    });
    p.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "gotcapped", version: "0.1.0" } } }) + "\n");
  });
}
export const codexInstalled = () => existsSync(join(codexHome(), "sessions")) || existsSync(join(codexHome(), "auth.json"));
export { PLAN as CODEX_PLAN };
