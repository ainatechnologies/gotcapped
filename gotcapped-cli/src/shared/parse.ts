// Parsing pasted usage output. Runs in the browser (and in tests). It only returns what it is sure of; the user confirms the
// bar % and reset time before submitting. Token counts are kept per model and per time bucket so we can (1) price them
// ourselves and (2) keep only the tokens that fall inside the same limit window as the bar reading.
import type { Usage } from "./prices";

export type Gran = "exact" | "block" | "day" | "session";
export type Row = { t0: number; t1: number; usage: Usage[]; split?: boolean; toolUsd?: number };
export type Delta = { kind: "5h" | "weekly"; pct: number; resetAt: number; t0: number; t1: number; usage: Usage[] };
export type Section = { provider: string; pct5h?: number; pctWeek?: number; reset5h?: number; resetWeek?: number; rows?: Row[]; gran?: Gran };
export type Parsed = {
  source?: string; tool?: string; gran?: Gran; rows?: Row[]; deltas?: Delta[]; sections?: Section[];
  pct5h?: number; pctWeek?: number; reset5h?: number; resetWeek?: number; pctMonth?: number;
  notes: string[]; models?: string[]; tokensOnly?: number; // tokensOnly: a total with no model split (can't be priced)
};

const N = (v: any) => { const n = Number(typeof v === "string" ? v.replace(/[,_\s$]/g, "") : v); return isFinite(n) ? n : 0; };
const DAY = 864e5, H = 36e5;

// ---------- dates ----------
const MON = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
// A calendar day string → local midnight (ccusage and CodexBar bucket days in the machine's local time zone).
export function dayStart(s: string): number | undefined {
  let m = s.match(/(\d{4})-(\d{2})-(\d{2})/); if (m) return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  m = s.match(/([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})/); if (m && MON.includes(m[1].toLowerCase())) return new Date(+m[3], MON.indexOf(m[1].toLowerCase()), +m[2]).getTime();
  return undefined;
}
const tsOf = (v: any): number | undefined => { if (v == null || v === "") return; if (typeof v === "number") return v < 1e11 ? v * 1000 : v; const t = Date.parse(v); return isNaN(t) ? undefined : t; };
function clock(s: string) { const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i); if (!m) return null; let h = +m[1]; const mi = +(m[2] || 0), ap = m[3]?.toLowerCase(); if (ap === "pm" && h < 12) h += 12; if (ap === "am" && h === 12) h = 0; if (!ap && !m[2]) return null; return h > 23 ? null : [h, mi] as const; }
// "in 3d 4h", "in 2 hr 13 min", "Thu 10:00 AM", "Oct 15, 9:00am", "15 Oct 09:00", "10:00 PM", ISO, epoch.
export function parseReset(s: string | undefined, now = Date.now()): number | undefined {
  if (!s) return; const t = s.trim(); if (!t) return;
  if (/^\d{10,13}$/.test(t)) return tsOf(Number(t));
  if (/^\d{4}-\d{2}-\d{2}T/.test(t)) return tsOf(t);
  const rel = t.match(/in\s+((?:\d+\s*(?:days?|d|hours?|hrs?|h|minutes?|mins?|m)\b[\s,]*)+)/i) || (/^(\d+\s*(d|h|m)\b\s*)+$/i.test(t) ? [t, t] : null);
  if (rel) { let ms = 0; for (const x of rel[1].matchAll(/(\d+)\s*(d|h|m)/gi)) ms += +x[1] * (x[2].toLowerCase() === "d" ? DAY : x[2].toLowerCase() === "h" ? H : 6e4); return ms ? now + ms : undefined; }
  const lower = t.toLowerCase(), base = new Date(now);
  const mon = lower.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b|\b(\d{1,2})\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/);
  const ck = clock(lower.replace(/\b\d{1,2}(st|nd|rd|th)?\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*|(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(st|nd|rd|th)?,?/g, " ")) ?? [0, 0];
  if (mon) {
    const mo = MON.indexOf((mon[1] || mon[4]).slice(0, 3)), day = +(mon[2] || mon[3]);
    let d = new Date(base.getFullYear(), mo, day, ck[0], ck[1]); if (d.getTime() < now - 30 * DAY) d = new Date(base.getFullYear() + 1, mo, day, ck[0], ck[1]); return d.getTime();
  }
  const dw = lower.match(/\b(sun|mon|tue|wed|thu|fri|sat)[a-z]*/);
  if (dw) { const want = DOW.indexOf(dw[1]); const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), ck[0], ck[1]); let add = (want - d.getDay() + 7) % 7; if (add === 0 && d.getTime() <= now) add = 7; return d.getTime() + add * DAY; }
  const c = clock(lower); if (c) { const d = new Date(base.getFullYear(), base.getMonth(), base.getDate(), c[0], c[1]).getTime(); return d > now ? d : d + DAY; }
  return undefined;
}

// ---------- tokens ----------
// Normalise one token record. OpenAI-style records count cached input inside input, so split it out.
export function tok(o: any, m: string): Usage | null {
  if (!o || typeof o !== "object") return null;
  const openai = o.cachedInputTokens != null || o.cached_input_tokens != null;
  let inp = N(o.inputTokens ?? o.input_tokens ?? o.input ?? o.totalInputTokens);
  const out = N(o.outputTokens ?? o.output_tokens ?? o.output ?? o.totalOutputTokens);
  const cr = N(o.cacheReadTokens ?? o.cacheReadInputTokens ?? o.cache_read_input_tokens ?? o.cachedInputTokens ?? o.cached_input_tokens);
  const cw1h = N(o.cache_creation?.ephemeral_1h_input_tokens ?? o.cacheCreation1hTokens);
  const cwAll = N(o.cacheCreationTokens ?? o.cacheCreationInputTokens ?? o.cache_creation_input_tokens ?? o.cacheWriteTokens);
  const cw = Math.max(0, cwAll - cw1h);
  if (openai) inp = Math.max(0, inp - cr);
  if (!inp && !out && !cr && !cw && !cw1h) return null;
  return { m, in: inp, out, cr, cw, ...(cw1h ? { cw1h } : {}) };
}
const sumU = (a: Usage[]) => a.reduce((s, u) => s + u.in + u.out + u.cr + u.cw + (u.cw1h ?? 0), 0);
export function mergeUsage(list: Usage[]): Usage[] {
  const by = new Map<string, Usage>();
  for (const u of list) { const k = u.m.toLowerCase(); const x = by.get(k) ?? { m: u.m, in: 0, out: 0, cr: 0, cw: 0 }; x.in += u.in; x.out += u.out; x.cr += u.cr; x.cw += u.cw; if (u.cw1h) x.cw1h = (x.cw1h ?? 0) + u.cw1h; by.set(k, x); }
  return [...by.values()];
}
// A bucket with category totals but only per-model totals: split categories by each model's share of tokens (flagged as estimated).
function splitByShare(total: Usage, shares: { m: string; t: number }[]): Usage[] {
  const all = shares.reduce((a, s) => a + s.t, 0); if (!all) return [];
  return shares.map((s) => { const f = s.t / all; return { m: s.m, in: total.in * f, out: total.out * f, cr: total.cr * f, cw: total.cw * f, ...(total.cw1h ? { cw1h: total.cw1h * f } : {}) }; });
}
// One time bucket from a ccusage / CodexBar style object.
function bucket(o: any, t0: number, t1: number): Row | null {
  const toolUsd = o.totalCost ?? o.costUSD ?? o.cost;
  if (Array.isArray(o.modelBreakdowns) && o.modelBreakdowns.length) {
    const exact = o.modelBreakdowns.map((b: any) => tok(b, String(b.modelName ?? b.model))).filter(Boolean) as Usage[];
    if (exact.length === o.modelBreakdowns.length) return { t0, t1, usage: exact, toolUsd: toolUsd != null ? N(toolUsd) : undefined };
    const total = tok(o.tokenCounts ?? o, "_"); if (!total) return null;
    if (o.modelBreakdowns.length === 1) return { t0, t1, usage: [{ ...total, m: String(o.modelBreakdowns[0].modelName) }], toolUsd };
    return { t0, t1, usage: splitByShare(total, o.modelBreakdowns.map((b: any) => ({ m: String(b.modelName), t: N(b.totalTokens) }))), split: true, toolUsd };
  }
  if (o.models && !Array.isArray(o.models) && typeof o.models === "object") { // ccusage codex: { models: { name: {inputTokens, cachedInputTokens, ...} } }
    const us = Object.entries(o.models).map(([m, v]) => tok(v, m)).filter(Boolean) as Usage[];
    if (us.length) return { t0, t1, usage: us, toolUsd: toolUsd != null ? N(toolUsd) : undefined };
  }
  const names: string[] = (o.modelsUsed ?? o.models ?? []).filter((x: any) => typeof x === "string" && x !== "<synthetic>");
  const total = tok(o.tokenCounts ?? o, names[0] ?? "unknown"); if (!total) return null;
  if (names.length <= 1) return { t0, t1, usage: [total], toolUsd: toolUsd != null ? N(toolUsd) : undefined };
  return { t0, t1, usage: names.map((m) => ({ ...total, m, in: NaN })) as any, split: true, toolUsd }; // multi-model with no shares: unpriceable, marked NaN
}

// ---------- JSON formats ----------
function fromJson(j: any, out: Parsed): boolean {
  // Codex CLI rollout lines arrive as an array of events (see fromJsonl); here handle ccusage + CodexBar documents.
  if (Array.isArray(j) && j.length && j[0] && typeof j[0] === "object" && j[0].provider) { // CodexBar
    const secs: Section[] = [];
    for (const x of j) {
      const s: Section = { provider: String(x.provider) };
      for (const w of [x.usage?.primary, x.usage?.secondary, x.usage?.tertiary]) {
        if (!w || w.usedPercent == null) continue; const mins = N(w.windowMinutes);
        if (mins && mins <= 600) { s.pct5h ??= Math.round(w.usedPercent); s.reset5h ??= tsOf(w.resetsAt); } else if (mins >= 5000 && mins <= 12000) { s.pctWeek ??= Math.round(w.usedPercent); s.resetWeek ??= tsOf(w.resetsAt); }
      }
      if (Array.isArray(x.daily)) { s.rows = x.daily.map((d: any) => { const t0 = dayStart(String(d.date)); return t0 == null ? null : bucket(d, t0, t0 + DAY); }).filter(Boolean) as Row[]; s.gran = "day"; }
      if (s.pct5h != null || s.pctWeek != null || s.rows?.length) secs.push(s);
    }
    if (!secs.length) return false;
    out.sections = secs; out.source = "CodexBar"; return true;
  }
  if (!j || typeof j !== "object") return false;
  if (Array.isArray(j.blocks)) { // ccusage blocks --json
    const rows = j.blocks.filter((b: any) => !b.isGap).map((b: any) => { const t0 = tsOf(b.startTime), t1 = tsOf(b.actualEndTime ?? b.endTime) ?? (t0 ? t0 + 5 * H : undefined); return t0 && t1 ? bucket(b, t0, t1) : null; }).filter(Boolean) as Row[];
    if (!rows.length) return false;
    out.rows = rows; out.gran = "block"; out.source = "ccusage blocks --json"; out.tool = "Claude Code";
    const active = j.blocks.find((b: any) => b.isActive); if (active) out.reset5h = tsOf(active.endTime);
    return true;
  }
  const codexFmt = (arr: any[]) => arr.some((d) => d && (d.cachedInputTokens != null || (d.models && !Array.isArray(d.models))));
  for (const [key, len, src] of [["daily", DAY, "daily"], ["weekly", 7 * DAY, "weekly"], ["monthly", 0, "monthly"]] as const) {
    const arr = j[key]; if (!Array.isArray(arr)) continue;
    const rows = arr.map((d: any) => {
      const label = String(d.date ?? d.week ?? d.month ?? ""); let t0 = dayStart(label.length === 7 ? label + "-01" : label); if (t0 == null) return null;
      const t1 = len ? t0 + len : new Date(new Date(t0).getFullYear(), new Date(t0).getMonth() + 1, 1).getTime();
      return bucket(d, t0, t1);
    }).filter(Boolean) as Row[];
    if (!rows.length) continue;
    out.rows = rows; out.gran = "day"; const cx = codexFmt(arr);
    out.tool = cx ? "Codex CLI" : "Claude Code"; out.source = `${cx ? "ccusage codex" : "ccusage"} ${src} --json`;
    return true;
  }
  if (Array.isArray(j.sessions)) { // ccusage session --json: only a last-activity date per session
    const rows = j.sessions.map((s: any) => { const t0 = dayStart(String(s.lastActivity ?? s.lastActivityDate ?? "")); return t0 == null ? null : bucket(s, t0, t0 + DAY); }).filter(Boolean) as Row[];
    if (!rows.length) return false;
    out.rows = rows; out.gran = "session"; out.source = "ccusage session --json"; out.tool = "Claude Code";
    out.notes.push("Session output only has each session's last-activity day, so sessions that started before your window may be partly counted.");
    return true;
  }
  return false;
}

// Codex CLI session log (~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl). Each token_count event carries the turn's tokens and
// the live rate-limit meters, so tokens and bar % come from the same moment. We use the change in % over the session.
function fromJsonl(lines: any[], out: Parsed): boolean {
  let model = "gpt-5-codex"; const ev: { t: number; u: Usage | null; rl: any }[] = [];
  for (const l of lines) {
    const p = l?.payload ?? l; const t = tsOf(l?.timestamp) ?? 0;
    if ((l?.type === "turn_context" || p?.type === "turn_context") && p?.model) model = String(p.model);
    if (l?.type === "session_meta" && p?.model) model = String(p.model);
    if (p?.type === "token_count") { const last = p.info?.last_token_usage; ev.push({ t, u: last ? tok(last, model) : null, rl: p.rate_limits }); }
  }
  if (!ev.length) return false;
  out.source = "Codex CLI session log"; out.tool = "Codex CLI"; out.gran = "exact";
  out.rows = ev.filter((e) => e.u).map((e) => ({ t0: e.t, t1: e.t, usage: [e.u!] }));
  const deltas: Delta[] = [];
  for (const [which, kind] of [["primary", "5h"], ["secondary", "weekly"]] as const) {
    const pts = ev.map((e, i) => { const w = e.rl?.[which]; if (!w || w.used_percent == null) return null; const reset = tsOf(w.resets_at) ?? (w.resets_in_seconds != null ? e.t + N(w.resets_in_seconds) * 1000 : undefined); return { i, t: e.t, pct: N(w.used_percent), reset, mins: N(w.window_minutes) }; }).filter(Boolean) as any[];
    if (pts.length < 2) { if (pts.length === 1) { if (kind === "5h") { out.pct5h = Math.round(pts[0].pct); out.reset5h = pts[0].reset; } else { out.pctWeek = Math.round(pts[0].pct); out.resetWeek = pts[0].reset; } } continue; }
    const realKind = pts[0].mins && pts[0].mins > 600 ? "weekly" : kind;
    // keep the last stretch with one reset time (±10 min); a reset in the middle starts a new window
    let s = pts.length - 1; while (s > 0 && pts[s - 1].reset && pts[s].reset && Math.abs(pts[s - 1].reset - pts[s].reset) < 6e5 && pts[s - 1].pct <= pts[s].pct) s--;
    const a = pts[s], b = pts[pts.length - 1];
    const usage = mergeUsage(ev.slice(a.i + 1, b.i + 1).map((e) => e.u).filter(Boolean) as Usage[]);
    if (realKind === "5h") { out.pct5h = Math.round(b.pct); out.reset5h = b.reset; } else { out.pctWeek = Math.round(b.pct); out.resetWeek = b.reset; }
    if (b.pct > a.pct && usage.length) deltas.push({ kind: realKind, pct: b.pct - a.pct, resetAt: b.reset ?? 0, t0: a.t, t1: b.t, usage });
  }
  out.deltas = deltas;
  out.notes.push("Codex session log: we use how far the bar moved during this session against the tokens of the same turns. Other Codex use at the same time would make this read low.");
  return true;
}

// ---------- text formats ----------
const pctUsed = (s: string) => { const m = s.match(/(\d{1,3}(?:\.\d+)?)\s*%\s*(used|left|remaining)?/i); if (!m) return undefined; const v = Number(m[1]); if (v > 100) return undefined; return /left|remaining/i.test(m[2] || "") ? Math.round(100 - v) : Math.round(v); };
const resetText = (s: string) => s.match(/resets?\s*(?:in|at|on)?\s*([^)│|\n]+)/i)?.[0].replace(/^resets?\s*(at|on)?\s*/i, "").trim();

function codexStatus(t: string, out: Parsed) {
  const lines = t.split(/\r?\n/);
  const five = lines.find((l) => /5\s*h(our)?\s*limit\s*:/i.test(l)), week = lines.find((l) => /weekly\s*limit\s*:/i.test(l));
  if (!five && !week) return false;
  if (five) { out.pct5h = pctUsed(five.replace(/^[^:]*:/, "")); out.reset5h = parseReset(resetText(five)); }
  if (week) { out.pctWeek = pctUsed(week.replace(/^[^:]*:/, "")); out.resetWeek = parseReset(resetText(week)); }
  const tk = t.match(/token usage:\s*([\d.,]+)\s*([KMB])?\s*total/i);
  if (tk) out.tokensOnly = Math.round(N(tk[1]) * ({ K: 1e3, M: 1e6, B: 1e9 } as any)[(tk[2] || "").toUpperCase()] || N(tk[1]));
  out.tool = "Codex CLI"; out.source = "Codex /status";
  out.notes.push("/status shows the bar but only a session token total, with no split by model. Add a Codex session log or ccusage codex output for the $ figure.");
  return true;
}
function codexBarText(t: string, out: Parsed) {
  if (!(/^==\s.+==\s*$/m.test(t) && /^(Session|Weekly):/m.test(t))) return false;
  const secs: Section[] = [];
  for (const p of t.split(/^==\s*/m).filter((x) => x.trim())) {
    const name = p.split("\n")[0].replace(/==\s*$/, "").replace(/\s+[\d.]+.*$/, "").replace(/\s*\(.*$/, "").trim();
    const lines = p.split(/\r?\n/), sec: Section = { provider: name };
    lines.forEach((l, i) => { const m = l.match(/^(Session|Weekly):\s*(.*)$/i); if (!m) return; const v = pctUsed(m[2]); const nx = lines.slice(i + 1, i + 4).find((x) => /^Resets/i.test(x))?.replace(/^Resets\s*/i, ""); if (/session/i.test(m[1])) { sec.pct5h = v; sec.reset5h = parseReset(nx); } else { sec.pctWeek = v; sec.resetWeek = parseReset(nx); } });
    if (sec.pct5h != null || sec.pctWeek != null) secs.push(sec);
  }
  if (!secs.length) return false;
  out.sections = [...(out.sections ?? []), ...secs]; out.source = "CodexBar"; return true;
}
function claudeUsagePage(t: string, out: Parsed) {
  if (!/(current session|weekly limits?|all models)/i.test(t) || !/%\s*used/i.test(t)) return false;
  const wi = t.toLowerCase().search(/weekly/);
  const before = wi >= 0 ? t.slice(0, wi) : t, after = wi >= 0 ? t.slice(wi) : "";
  const s = before.match(/(\d{1,3})\s*%\s*used/i); if (s && /session/i.test(before)) { out.pct5h = Number(s[1]); out.reset5h = parseReset(resetText(before)); }
  const w = after.match(/(\d{1,3})\s*%\s*used/i); if (w) { out.pctWeek = Number(w[1]); out.resetWeek = parseReset(resetText(after.slice(0, after.search(/%\s*used/i) + 12))); }
  out.source = out.source ?? "Claude usage page"; out.tool = out.tool ?? "Claude Code";
  return true;
}
// ccusage text table: │ Date │ Models │ Input │ Output │ Cache Create │ Cache Read │ Total Tokens │ Cost (USD) │
// The models cell lists one model per line ("- opus-4-5"); with --breakdown each model gets its own └─ row with numbers.
function ccusageTable(t: string, out: Parsed) {
  const lines = t.split(/\r?\n/).filter((l) => /[│|]/.test(l));
  if (!lines.some((l) => /cache\s*(create|read)/i.test(l)) && !lines.some((l) => /\d{4}-\d{2}-\d{2}/.test(l) && /\$[\d.]+/.test(l))) return false;
  type R = { t0: number; names: string[]; agg?: number[]; br: Usage[] };
  const rows: R[] = []; let cur: R | null = null;
  for (const l of lines) {
    const cells = l.split(/[│|]/).map((c) => c.trim()).filter((c, i, a) => !(c === "" && (i === 0 || i === a.length - 1)));
    if (!cells.length || /^[─\-=┼├┤+\s]*$/.test(cells.join(""))) continue;
    const nums = cells.map((c) => (/^\$?[\d,]+(\.\d+)?$/.test(c) ? N(c) : null));
    const firstNum = nums.findIndex((x) => x != null);
    const d = cells[0].match(/\d{4}-\d{2}-\d{2}/);
    if (d) { cur = { t0: dayStart(d[0])!, names: [], br: [] }; rows.push(cur); }
    if (!cur) continue;
    const label = cells.slice(0, firstNum < 0 ? cells.length : firstNum).join(" ");
    const isBr = /[└├]─/.test(label);
    const name = label.replace(/\d{4}-\d{2}-\d{2}/, "").replace(/^[\s└├─•\-]+/, "").replace(/\s+-\s+/g, ", ").trim();
    const vals = nums.filter((x) => x != null) as number[];
    if (isBr && vals.length >= 4) { cur.br.push({ m: name, in: vals[0], out: vals[1], cw: vals[2], cr: vals[3] }); continue; }
    if (name && !/^total$/i.test(name)) cur.names.push(...name.split(/,\s*/).filter(Boolean));
    if (!isBr && vals.length >= 4 && !cur.agg) cur.agg = vals;
  }
  const done: Row[] = [];
  for (const r of rows) {
    if (r.br.length) done.push({ t0: r.t0, t1: r.t0 + DAY, usage: r.br });
    else if (r.agg) { const u = { in: r.agg[0], out: r.agg[1], cw: r.agg[2], cr: r.agg[3] }; if (r.names.length === 1) done.push({ t0: r.t0, t1: r.t0 + DAY, usage: [{ m: r.names[0], ...u }] }); else done.push({ t0: r.t0, t1: r.t0 + DAY, usage: (r.names.length ? r.names : ["unknown"]).map((m) => ({ m, ...u, in: NaN })), split: true }); }
  }
  if (!done.length) return false;
  out.rows = done; out.gran = "day"; out.source = "ccusage table"; out.tool = out.tool ?? "Claude Code";
  if (done.some((r) => r.split)) out.notes.push("Some days used more than one model without a per-model split. Run it with --breakdown (or --json) so we can price each model.");
  return true;
}
// Cursor dashboard → Usage → Export CSV.
function cursorCsv(t: string, out: Parsed) {
  const lines = t.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return false;
  const split = (l: string) => { const o: string[] = []; let cur = "", q = false; for (let i = 0; i < l.length; i++) { const c = l[i]; if (q) { if (c === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c; } else if (c === '"') q = true; else if (c === ",") { o.push(cur.trim()); cur = ""; } else cur += c; } o.push(cur.trim()); return o; };
  const head = split(lines[0]).map((h) => h.toLowerCase());
  const col = (re: RegExp) => head.findIndex((h) => re.test(h));
  const ci = { date: col(/^date/), kind: col(/^kind/), model: col(/^model/), inW: col(/input.*w\/\s*cache write|with cache write/), inWO: col(/input.*w\/o|without cache/), input: col(/^input/), cr: col(/cache read/), out: col(/^output/), cost: col(/^cost/) };
  if (ci.model < 0 || (ci.out < 0 && ci.input < 0)) return false;
  const rows: Row[] = []; let skipped = 0;
  for (const l of lines.slice(1)) {
    const c = split(l); if (c.length < head.length - 1) continue;
    if (ci.kind >= 0 && /errored|not charged|on-demand|usage-based/i.test(c[ci.kind])) { skipped++; continue; }
    const t0 = tsOf(c[ci.date]) ?? dayStart(c[ci.date] || ""); if (t0 == null) continue;
    const inWO = ci.inWO >= 0 ? N(c[ci.inWO]) : N(c[ci.input]), inW = ci.inW >= 0 ? N(c[ci.inW]) : inWO;
    rows.push({ t0, t1: t0, usage: [{ m: c[ci.model], in: inWO, cw: Math.max(0, inW - inWO), cr: ci.cr >= 0 ? N(c[ci.cr]) : 0, out: ci.out >= 0 ? N(c[ci.out]) : 0 }], toolUsd: ci.cost >= 0 ? N(c[ci.cost]) : undefined });
  }
  if (!rows.length) return false;
  out.rows = rows; out.gran = "exact"; out.source = "Cursor usage CSV"; out.tool = "Cursor";
  if (skipped) out.notes.push(`${skipped} on-demand or errored rows left out: they don't count against your included usage.`);
  return true;
}

// Pull every top-level JSON document out of a paste (people paste two outputs at once).
function jsonDocs(t: string): { docs: any[]; rest: string } {
  const docs: any[] = []; let rest = ""; let i = 0;
  while (i < t.length) {
    const ch = t[i];
    if (ch === "{" || ch === "[") {
      let depth = 0, inStr = false, esc = false, j = i;
      for (; j < t.length; j++) { const c = t[j]; if (inStr) { if (esc) esc = false; else if (c === "\\") esc = true; else if (c === '"') inStr = false; continue; } if (c === '"') inStr = true; else if (c === "{" || c === "[") depth++; else if (c === "}" || c === "]") { depth--; if (!depth) break; } }
      const chunk = t.slice(i, j + 1);
      try { docs.push(JSON.parse(chunk)); i = j + 1; continue; } catch { /* not JSON, fall through */ }
    }
    rest += ch; i++;
  }
  return { docs, rest };
}

export function parseUsage(text: string): Parsed {
  const out: Parsed = { notes: [] }; const t = text.trim(); if (!t) return out;
  // JSONL (Codex session log): many lines that are each a JSON object
  const ls = t.split(/\r?\n/).filter((l) => l.trim());
  if (ls.length > 1 && ls.every((l) => /^\s*\{.*\}\s*$/.test(l))) { try { const objs = ls.map((l) => JSON.parse(l)); if (fromJsonl(objs, out)) return finish(out); if (objs.length) for (const o of objs) fromJson(o, out); if (out.rows || out.sections) return finish(out); } catch {} }
  const { docs, rest } = jsonDocs(t);
  for (const d of docs) { const tmp: Parsed = { notes: [] }; if (fromJson(d, tmp)) merge(out, tmp); }
  const txt = docs.length ? rest : t;
  if (txt.trim()) {
    const tmp: Parsed = { notes: [] };
    codexStatus(txt, tmp) || codexBarText(txt, tmp); claudeUsagePage(txt, tmp); ccusageTable(txt, tmp) || cursorCsv(txt, tmp);
    merge(out, tmp);
  }
  return finish(out);
}
function merge(a: Parsed, b: Parsed) {
  for (const k of ["pct5h", "pctWeek", "reset5h", "resetWeek", "tokensOnly"] as const) if (b[k] != null && a[k] == null) (a as any)[k] = b[k];
  if (b.rows?.length && !a.rows?.length) { a.rows = b.rows; a.gran = b.gran; }
  if (b.deltas?.length) a.deltas = b.deltas;
  if (b.sections) a.sections = [...(a.sections ?? []), ...b.sections];
  a.source = [a.source, b.source].filter(Boolean).join(" + ") || undefined; a.tool = a.tool ?? b.tool; a.notes.push(...b.notes);
}
function finish(o: Parsed) { const ms = new Set<string>(); for (const r of o.rows ?? []) for (const u of r.usage) ms.add(u.m); o.models = [...ms]; return o; }

const VENDOR_KEY = (v = "") => { const w = v.toLowerCase(); return w.includes("anthropic") ? "claude" : w.includes("openai") ? "codex" : w.includes("cursor") ? "cursor" : w.includes("google") ? "gemini" : w.includes("xai") ? "grok" : w.includes("github") ? "copilot" : ""; };
// For CodexBar, pick the provider section that matches the plan's vendor and lift its numbers to the top level.
export function forVendor(p: Parsed, vendor?: string): Parsed {
  if (!p.sections?.length) return p;
  const key = VENDOR_KEY(vendor), match = (s: Section) => key && s.provider.toLowerCase().includes(key);
  const bar = p.sections.find((s) => match(s) && (s.pct5h != null || s.pctWeek != null)), cost = p.sections.find((s) => match(s) && s.rows?.length);
  const q: Parsed = { ...p, notes: [...p.notes] };
  if (bar) { q.pct5h ??= bar.pct5h; q.pctWeek ??= bar.pctWeek; q.reset5h ??= bar.reset5h; q.resetWeek ??= bar.resetWeek; }
  if (cost && !q.rows?.length) { q.rows = cost.rows; q.gran = cost.gran; }
  if (!bar && !cost) q.notes.push(`No ${key || "matching"} section found in the CodexBar output.`);
  return finish(q);
}

// ---------- windowing ----------
export const WINDOW_MS: Record<string, number> = { "5h": 5 * H, weekly: 7 * DAY };
export function windowStart(kind: string, resetAt: number) { if (kind === "monthly") { const d = new Date(resetAt); return new Date(d.getFullYear(), d.getMonth() - 1, d.getDate(), d.getHours(), d.getMinutes()).getTime(); } return resetAt - (WINDOW_MS[kind] ?? 7 * DAY); }
export type Windowed = { usage: Usage[]; dataStart: number; dataEnd: number; gran: Gran; split: boolean; unsplit: boolean; dropped: number; toolUsd?: number; pct?: number; delta?: boolean };
// Keep only tokens inside [reset − window, reset]. Day buckets overlapping the start are kept (flagged by granularity).
export function inWindow(p: Parsed, kind: string, resetAt: number): Windowed | null {
  const d = p.deltas?.find((x) => x.kind === kind);
  if (d) return { usage: d.usage, dataStart: d.t0, dataEnd: d.t1, gran: "exact", split: false, unsplit: false, dropped: 0, pct: d.pct, delta: true };
  if (!p.rows?.length || !resetAt) return null;
  const ws = windowStart(kind, resetAt);
  const keep = p.rows.filter((r) => r.t1 >= ws && r.t0 <= resetAt && (r.t1 > ws || r.t0 === r.t1));
  if (!keep.length) return { usage: [], dataStart: 0, dataEnd: 0, gran: p.gran ?? "day", split: false, unsplit: false, dropped: p.rows.length };
  const all = keep.flatMap((r) => r.usage);
  const tools = keep.map((r) => r.toolUsd).filter((x) => x != null) as number[];
  return {
    usage: mergeUsage(all.filter((u) => !isNaN(u.in))), dataStart: Math.min(...keep.map((r) => r.t0)), dataEnd: Math.max(...keep.map((r) => r.t1)), gran: p.gran ?? "day",
    split: keep.some((r) => r.split && !r.usage.some((u) => isNaN(u.in))), unsplit: all.some((u) => isNaN(u.in)), dropped: p.rows.length - keep.length,
    toolUsd: tools.length === keep.length ? tools.reduce((a, b) => a + b, 0) : undefined,
  };
}
export { sumU };
