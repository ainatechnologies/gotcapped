import { createHmac, createHash, randomBytes } from "crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Public, versioned pepper. It is in the open-source code on purpose: the same account must hash the same on every
// device so the server can merge them. Account IDs are random UUIDs, so the hash can't be reversed by guessing.
export const PEPPER = "gotcapped-pepper-v1";
export const VERSION = "0.1.0";
export const hmac = (s: string, len = 32) => createHmac("sha256", PEPPER).update(s).digest("hex").slice(0, len);
export const accountKey = (vendor: string, accountId: string, orgId = "") => hmac(`acct:${vendor}:${accountId}:${orgId}`, 32);
export const reqHash = (vendor: string, id: string) => hmac(`req:${vendor}:${id}`, 16);

export const home = () => process.env.GOTCAPPED_HOME || join(process.env.HOME || homedir(), ".gotcapped");
export const userHome = () => process.env.HOME || homedir();
export function ensureDir(d: string) { if (!existsSync(d)) mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
export const readJson = (p: string): any => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

export type Sample = { t: number; vendor: string; dir: string; account: string | null };
export type Manual = { vendor: string; account: string; kind: "5h" | "weekly"; pct: number; reset_at: number; read_at: number };
export type State = { device: string; secret: string; timeline: Sample[]; plans: Record<string, string>; manual: Manual[]; autoSend: boolean; nick?: Record<string, string> };

export function loadState(): State {
  const s = readJson(join(home(), "state.json")) ?? {};
  return { device: s.device || randomBytes(16).toString("hex"), secret: s.secret || randomBytes(32).toString("hex"), timeline: s.timeline ?? [], plans: s.plans ?? {}, manual: s.manual ?? [], autoSend: !!s.autoSend, nick: s.nick ?? {} };
}
export function saveState(s: State) {
  ensureDir(home());
  const cut = Date.now() - 40 * 864e5;
  s.timeline = s.timeline.filter((x) => x.t > cut).slice(-20000);
  s.manual = s.manual.filter((x) => x.reset_at > cut);
  writeFileSync(join(home(), "state.json"), JSON.stringify(s, null, 1), { mode: 0o600 });
}
// Record which account is active in a config dir. Appends only on change or every 5 minutes (heartbeat).
export function sample(s: State, vendor: string, dir: string, account: string | null, t = Date.now()) {
  const last = [...s.timeline].reverse().find((x) => x.vendor === vendor && x.dir === dir);
  if (!last || last.account !== account || t - last.t >= 5 * 6e4) s.timeline.push({ t, vendor, dir, account });
}
export const appendLine = (p: string, o: any) => { ensureDir(home()); appendFileSync(p, JSON.stringify(o) + "\n", { mode: 0o600 }); };

export function walk(dir: string, re: RegExp, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || !existsSync(dir)) return out;
  for (const n of readdirSync(dir)) {
    const p = join(dir, n); let st; try { st = statSync(p); } catch { continue; }
    if (st.isDirectory()) walk(p, re, out, depth + 1); else if (re.test(n)) out.push(p);
  }
  return out;
}
export const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return 0; } };
// Epoch seconds, epoch ms, or ISO → ms.
export const toMs = (v: any): number | undefined => { if (v == null || v === "") return; if (typeof v === "number") return v < 1e11 ? v * 1000 : v; const t = Date.parse(String(v)); return isNaN(t) ? undefined : t; };
// Device ownership: the secret never leaves this machine except in a DELETE request; uploads carry only its sha256.
export const proofOf = (secret: string) => createHash("sha256").update(secret).digest("hex");
