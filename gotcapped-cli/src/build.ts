// Turn local entries + bar readings into account-window readings (the exact payload that leaves the device).
import { priceUsage, longCtxLimit, type Usage } from "./shared/prices";
import { attributor } from "./attrib";
import type { Entry, Bar } from "./claude";
import type { Sample } from "./util";

export const WINDOW_MS = { "5h": 5 * 36e5, weekly: 7 * 864e5 } as const;
const q15 = (t: number) => new Date(Math.round(t / 9e5) * 9e5).toISOString(); // §5: window times rounded to 15 min
export type Reading = {
  vendor: "claude" | "codex"; plan: string; account: string; seat?: string; kind: "5h" | "weekly"; reset_at: string;
  bar: { pct: number; read_at: string; source: Bar["source"] }; data_start: string; data_end: string;
  attribution: "observed" | "inferred"; ambiguous_share: number; usage: Usage[]; req: string[];
};
export type Local = { reading: Reading; usd: number; perBar: number | null; tokens: number; entries: number; note?: string };

// For each account and window kind, pick the latest bar reading of the current (or just-closed) window.
export function latestBars(bars: Bar[], now = Date.now()) {
  const best = new Map<string, Bar>();
  for (const b of bars) {
    if (!b.account || b.reset < now - 7 * 864e5 || b.t > b.reset || b.t < b.reset - WINDOW_MS[b.kind]) continue;
    const k = `${b.account}|${b.dir}|${b.kind}`, cur = best.get(k);
    if (!cur || b.reset > cur.reset + 6e4 || (Math.abs(b.reset - cur.reset) <= 6e4 && b.t > cur.t)) best.set(k, b);
  }
  return [...best.values()];
}

export function buildReading(o: { vendor: "claude" | "codex"; plan: string; seat?: string; bar: Bar; entries: Entry[]; timeline: Sample[]; owners?: Map<string, string> }): Local {
  const { bar } = o, start = bar.reset - WINDOW_MS[bar.kind], end = bar.t;
  const who = attributor(o.timeline, o.vendor, bar.dir);
  const inWin = o.entries.filter((e) => e.t >= start && e.t <= end);
  let amb = 0, inferred = false; const mine: Entry[] = [];
  for (const e of inWin) {
    // A session we know the owner of (Claude desktop app) is attributed directly; everything else uses the timeline.
    const own = e.s ? o.owners?.get(e.s) : undefined;
    if (own) { if (own === bar.account) mine.push(e); continue; }
    const a = who(e.t);
    if (a.how === "ambiguous") { amb += e.in + e.out + e.cr + e.cw + e.cw1h; continue; }
    if (a.account !== bar.account) continue; // another account's tokens: never divided by this account's bar
    if (a.how === "inferred") inferred = true;
    mine.push(e);
  }
  const m = new Map<string, Usage>();
  for (const e of mine) {
    const u = m.get(e.m) ?? { m: e.m, in: 0, out: 0, cr: 0, cw: 0, cw1h: 0, lc: 0 }; u.in += e.in; u.out += e.out; u.cr += e.cr; u.cw += e.cw; u.cw1h! += e.cw1h;
    const lim = longCtxLimit(e.m); if (lim != null && e.in + e.cr + e.cw + e.cw1h > lim) u.lc! += 1; // per request, never aggregated
    m.set(e.m, u);
  }
  const usage = [...m.values()].map(({ cw1h, lc, ...u }) => ({ ...u, ...(cw1h ? { cw1h } : {}), ...(lc ? { lc } : {}) }));
  const tokens = mine.reduce((a, e) => a + e.in + e.out + e.cr + e.cw + e.cw1h, 0);
  const reading: Reading = {
    vendor: o.vendor, plan: o.plan, account: bar.account!, ...(o.seat ? { seat: o.seat } : {}), kind: bar.kind, reset_at: q15(bar.reset),
    bar: { pct: Math.round(bar.pct * 10) / 10, read_at: new Date(Math.floor(bar.t / 6e4) * 6e4).toISOString(), source: bar.source },
    data_start: q15(start), data_end: new Date(Math.floor(end / 6e4) * 6e4).toISOString(),
    attribution: inferred ? "inferred" : "observed", ambiguous_share: Math.round((amb / Math.max(1, amb + tokens)) * 1000) / 1000,
    usage, req: [...new Set(mine.map((e) => e.req))].sort(),
  };
  const usd = priceUsage(usage).usd;
  const note = bar.pct < 10 ? "Bar under 10%: shown here, but too small to count in the public median yet." : reading.ambiguous_share > 0.1 ? "Over 10% of tokens fall near a sign-in change, so this window won't count." : !usage.length ? "No tokens in this window." : undefined;
  return { reading, usd, perBar: bar.pct > 0 && usd > 0 ? usd / (bar.pct / 100) : null, tokens, entries: mine.length, note };
}

// What we show the user: the payload with request hashes collapsed to a count (the full file is written to the outbox).
export const previewOf = (p: { readings: Reading[] }) => ({ ...p, readings: p.readings.map((r) => ({ ...r, req: `[${r.req.length} one-way hashes of request IDs, for dedupe]` })) });
