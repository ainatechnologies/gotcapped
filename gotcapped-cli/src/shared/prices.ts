// Public API list prices, USD per 1M tokens, standard tier, short-context rates.
// Every row cites the official page it was read from. Bump the version whenever any rate changes;
// each report stores the version it was priced with, and old books stay here so history is reproducible.
export type Rate = { in: number; out: number; cr: number; cw: number };
export type PriceRow = { key: string; vendor: string; label: string; rate: Rate; src: string; note?: string; until?: string };
export type PriceBook = { version: string; checked: string; rows: PriceRow[] };

const A = "https://docs.claude.com/en/docs/about-claude/pricing";
const O = "https://platform.openai.com/docs/pricing";
const G = "https://ai.google.dev/gemini-api/docs/pricing";
const X = "https://docs.x.ai/docs/models";
const C = "https://cursor.com/docs/models";
const OM = (id: string) => `https://developers.openai.com/api/docs/models/${id}`;
const r = (i: number, o: number, cr: number, cw = i): Rate => ({ in: i, out: o, cr, cw });

const V1: PriceRow[] = [
  // Anthropic. cw = 5-minute cache write. 1-hour cache writes (cw1h) are priced at 2× input when the log splits them.
  { key: "claude:fable-5.1", vendor: "Anthropic", label: "Claude Fable 5.1", rate: r(10, 50, 0.25, 12.5), src: A },
  { key: "claude:mythos-5.1", vendor: "Anthropic", label: "Claude Mythos 5.1", rate: r(10, 50, 0.25, 12.5), src: A },
  { key: "claude:fable-5", vendor: "Anthropic", label: "Claude Fable 5", rate: r(10, 50, 1, 12.5), src: A },
  { key: "claude:mythos-5", vendor: "Anthropic", label: "Claude Mythos 5", rate: r(10, 50, 1, 12.5), src: A },
  { key: "claude:opus-5.5", vendor: "Anthropic", label: "Claude Opus 5.5", rate: r(4, 20, 0.2, 5), src: A },
  { key: "claude:opus-5", vendor: "Anthropic", label: "Claude Opus 5", rate: r(5, 25, 0.5, 6.25), src: A },
  { key: "claude:opus-4.8", vendor: "Anthropic", label: "Claude Opus 4.8", rate: r(5, 25, 0.5, 6.25), src: A },
  { key: "claude:opus-4.7", vendor: "Anthropic", label: "Claude Opus 4.7", rate: r(5, 25, 0.5, 6.25), src: A },
  { key: "claude:opus-4.6", vendor: "Anthropic", label: "Claude Opus 4.6", rate: r(5, 25, 0.5, 6.25), src: A },
  { key: "claude:opus-4.5", vendor: "Anthropic", label: "Claude Opus 4.5", rate: r(5, 25, 0.5, 6.25), src: A },
  { key: "claude:opus-4.1", vendor: "Anthropic", label: "Claude Opus 4.1", rate: r(15, 75, 1.5, 18.75), src: A },
  { key: "claude:opus-4", vendor: "Anthropic", label: "Claude Opus 4", rate: r(15, 75, 1.5, 18.75), src: A },
  { key: "claude:sonnet-5.5", vendor: "Anthropic", label: "Claude Sonnet 5.5", rate: r(2, 10, 0.1, 2.5), src: A },
  { key: "claude:sonnet-5", vendor: "Anthropic", label: "Claude Sonnet 5", rate: r(2, 10, 0.2, 2.5), src: A },
  { key: "claude:sonnet-4.6", vendor: "Anthropic", label: "Claude Sonnet 4.6", rate: r(3, 15, 0.3, 3.75), src: A },
  { key: "claude:sonnet-4.5", vendor: "Anthropic", label: "Claude Sonnet 4.5", rate: r(3, 15, 0.3, 3.75), src: A },
  { key: "claude:sonnet-4", vendor: "Anthropic", label: "Claude Sonnet 4", rate: r(3, 15, 0.3, 3.75), src: A },
  { key: "claude:haiku-5.5", vendor: "Anthropic", label: "Claude Haiku 5.5", rate: r(0.1, 0.5, 0.01, 0.125), src: A, note: "Prompts up to 100k tokens; longer prompts cost 5×" },
  { key: "claude:haiku-4.5", vendor: "Anthropic", label: "Claude Haiku 4.5", rate: r(1, 5, 0.1, 1.25), src: A },
  { key: "claude:haiku-3.5", vendor: "Anthropic", label: "Claude Haiku 3.5", rate: r(0.8, 4, 0.08, 1), src: A },
  // OpenAI. Short context (≤272k input). Cached input is part of input in OpenAI logs; parsers split it out.
  { key: "gpt-6-astra", vendor: "OpenAI", label: "GPT-6 Astra", rate: r(10, 50, 1, 12.5), src: O },
  { key: "gpt-6.1-sol", vendor: "OpenAI", label: "GPT-6.1 Sol", rate: r(2, 10, 0.1, 2.5), src: O },
  { key: "gpt-6-sol", vendor: "OpenAI", label: "GPT-6 Sol", rate: r(2, 10, 0.2, 2.5), src: O },
  { key: "gpt-6-luna", vendor: "OpenAI", label: "GPT-6 Luna", rate: r(0.1, 0.5, 0.01, 0.125), src: O },
  { key: "gpt-5.6-sol", vendor: "OpenAI", label: "GPT-5.6 Sol", rate: r(4, 20, 0.4, 5), src: O, note: "Promotional price, at least through 21 Nov 2026", until: "2026-11-21" },
  { key: "gpt-5.6-terra", vendor: "OpenAI", label: "GPT-5.6 Terra", rate: r(2, 12, 0.2, 2.5), src: O },
  { key: "gpt-5.6-luna", vendor: "OpenAI", label: "GPT-5.6 Luna", rate: r(0.2, 1.2, 0.02, 0.25), src: O },
  { key: "gpt-5.5", vendor: "OpenAI", label: "GPT-5.5", rate: r(5, 30, 0.5), src: O },
  { key: "gpt-5.4-mini", vendor: "OpenAI", label: "GPT-5.4 mini", rate: r(0.75, 4.5, 0.075), src: O },
  { key: "gpt-5.4-nano", vendor: "OpenAI", label: "GPT-5.4 nano", rate: r(0.2, 1.25, 0.02), src: O },
  { key: "gpt-5.4", vendor: "OpenAI", label: "GPT-5.4", rate: r(2.5, 15, 0.25), src: O },
  { key: "gpt-5.3-codex", vendor: "OpenAI", label: "GPT-5.3 Codex", rate: r(1.75, 14, 0.175), src: O },
  { key: "gpt-5.2-codex", vendor: "OpenAI", label: "GPT-5.2 Codex", rate: r(1.75, 14, 0.175), src: OM("gpt-5.2-codex") },
  { key: "gpt-5.2", vendor: "OpenAI", label: "GPT-5.2", rate: r(1.75, 14, 0.175), src: O },
  { key: "gpt-5.1-codex-mini", vendor: "OpenAI", label: "GPT-5.1 Codex Mini", rate: r(0.25, 2, 0.025), src: OM("gpt-5.1-codex-mini") },
  { key: "gpt-5.1-codex", vendor: "OpenAI", label: "GPT-5.1 Codex", rate: r(1.25, 10, 0.125), src: OM("gpt-5.1-codex") },
  { key: "gpt-5.1", vendor: "OpenAI", label: "GPT-5.1", rate: r(1.25, 10, 0.125), src: O },
  { key: "gpt-5-codex", vendor: "OpenAI", label: "GPT-5 Codex", rate: r(1.25, 10, 0.125), src: OM("gpt-5-codex") },
  { key: "gpt-5-mini", vendor: "OpenAI", label: "GPT-5 mini", rate: r(0.25, 2, 0.025), src: O },
  { key: "gpt-5-nano", vendor: "OpenAI", label: "GPT-5 nano", rate: r(0.05, 0.4, 0.005), src: O },
  { key: "gpt-5", vendor: "OpenAI", label: "GPT-5", rate: r(1.25, 10, 0.125), src: O },
  // Google. Paid tier, prompts ≤200k. Google lists the 3.6/3.8 Flash rates doubling on 1 Jan 2027.
  { key: "gemini-3.8-flash", vendor: "Google", label: "Gemini 3.8 Flash", rate: r(0.75, 3.75, 0.075), src: G, note: "Through 31 Dec 2026" },
  { key: "gemini-3.6-flash", vendor: "Google", label: "Gemini 3.6 Flash", rate: r(0.75, 3.75, 0.075), src: G, note: "Through 31 Dec 2026" },
  { key: "gemini-3.5-flash-lite", vendor: "Google", label: "Gemini 3.5 Flash-Lite", rate: r(0.3, 2.5, 0.03), src: G },
  { key: "gemini-3.1-pro", vendor: "Google", label: "Gemini 3.1 Pro", rate: r(2, 12, 0.2), src: G },
  { key: "gemini-3-flash", vendor: "Google", label: "Gemini 3 Flash", rate: r(0.5, 3, 0.05), src: G },
  { key: "gemini-2.5-pro", vendor: "Google", label: "Gemini 2.5 Pro", rate: r(1.25, 10, 0.125), src: G },
  { key: "gemini-2.5-flash-lite", vendor: "Google", label: "Gemini 2.5 Flash-Lite", rate: r(0.1, 0.4, 0.01), src: G },
  { key: "gemini-2.5-flash", vendor: "Google", label: "Gemini 2.5 Flash", rate: r(0.3, 2.5, 0.03), src: G },
  // xAI. Prompts <200k.
  { key: "grok-4.7", vendor: "xAI", label: "Grok 4.7", rate: r(2, 6, 0.5), src: X },
  { key: "grok-4.6", vendor: "xAI", label: "Grok 4.6", rate: r(2, 6, 0.5), src: X },
  { key: "grok-4.5", vendor: "xAI", label: "Grok 4.5", rate: r(2, 6, 0.3), src: X },
  { key: "grok-4.3", vendor: "xAI", label: "Grok 4.3", rate: r(1.25, 2.5, 0.2), src: X },
  { key: "grok-build-0.1", vendor: "xAI", label: "Grok Build 0.1", rate: r(1, 2, 0.2), src: X },
  // Cursor's own model, at Cursor's list price.
  { key: "composer-2.5", vendor: "Cursor", label: "Composer 2.5", rate: r(0.5, 2.5, 0.2), src: C },
];

export const PRICE_BOOKS: PriceBook[] = [{ version: "2026-10-13", checked: "2026-10-13", rows: V1 }];
export const CURRENT = PRICE_BOOKS[PRICE_BOOKS.length - 1];
export const PRICE_VERSION = CURRENT.version;
// The price book in force at a given time (audit §E.5: backfill is priced at the prices of its own window).
export const versionAt = (t: number | string) => { const d = new Date(t).toISOString().slice(0, 10); return [...PRICE_BOOKS].reverse().find((b) => b.version <= d)?.version ?? PRICE_BOOKS[0].version; };
export const bookFor = (v?: string) => PRICE_BOOKS.find((b) => b.version === v) ?? CURRENT;
export const PRICE_SOURCES = [{ vendor: "Anthropic", url: A }, { vendor: "OpenAI", url: O }, { vendor: "Google", url: G }, { vendor: "xAI", url: X }, { vendor: "Cursor", url: C }];

// Model name → price key. Handles "claude-opus-4-5-20251101", "opus-4.5", "Claude 4.5 Opus", "claude-opus-4-8-fast",
// "GPT-6.1 Sol", "gpt-5.3-codex-high", "gemini-3.1-pro-preview", "Grok 4.7 (Fast)", "anthropic/claude-sonnet-5".
export function modelKey(name: string, book = CURRENT): string | null {
  const s = name.toLowerCase().replace(/\[[^\]]*\]|\(|\)/g, "").replace(/\b\d{8}\b/g, "").replace(/^[a-z]+\//, "").trim().replace(/[_\s]+/g, "-");
  const fam = s.match(/(fable|mythos|opus|sonnet|haiku)/)?.[1];
  if (fam) {
    const v = s.replace(fam, "").match(/(\d+)(?:[.\-](\d+))?/);
    if (!v) return null;
    return [`claude:${fam}-${v[1]}${v[2] ? "." + v[2] : ""}`, `claude:${fam}-${v[1]}`].find((k) => book.rows.some((r) => r.key === k)) ?? null;
  }
  const t = s.replace(/-+/g, "-");
  const keys = book.rows.map((r) => r.key).filter((k) => !k.startsWith("claude:")).sort((a, b) => b.length - a.length);
  return keys.find((k) => t === k || t.startsWith(k + "-")) ?? null;
}

// cw = 5-minute cache writes (1.25× input). cw1h = 1-hour cache writes (2× input), only when the log splits them (Claude Code does).
// lc = number of requests in this row whose prompt (input + cache read + cache writes) exceeded the model's long-context
// price threshold. Counted per request on the device; only the count is sent.
export type Usage = { m: string; in: number; out: number; cr: number; cw: number; cw1h?: number; lc?: number };
// Prompt size above which the vendor charges a long-context rate (we don't apply that rate yet, so such readings are a floor
// and are marked as a floor). null = no long-context tier for this model.
export function longCtxLimit(model: string): number | null {
  const m = model.toLowerCase();
  if (/haiku-5[.-]5/.test(m)) return 100_000;
  if (/^(openai\/)?gpt-/.test(m)) return 272_000;
  if (/gemini-.*pro/.test(m)) return 200_000;
  if (/grok/.test(m)) return 199_999;
  return null;
}
export type Priced = { usd: number; lines: { m: string; key: string | null; label?: string; usd: number; tokens: number }[]; unpriced: string[]; unpricedShare: number; fast: boolean };
// Recompute cost from tokens with the given price book. Fast-mode names are priced at the standard rate (a floor) and flagged.
export function priceUsage(usage: Usage[], version?: string): Priced {
  const book = bookFor(version);
  const lines = usage.map((u) => {
    const key = modelKey(u.m, book), row = book.rows.find((x) => x.key === key);
    const tokens = u.in + u.out + u.cr + u.cw + (u.cw1h ?? 0);
    const usd = row ? (u.in * row.rate.in + u.out * row.rate.out + u.cr * row.rate.cr + u.cw * row.rate.cw + (u.cw1h ?? 0) * row.rate.in * 2) / 1e6 : 0;
    return { m: u.m, key: row ? key : null, label: row?.label, usd, tokens };
  });
  const tot = lines.reduce((a, l) => a + l.tokens, 0), un = lines.filter((l) => !l.key);
  return { usd: lines.reduce((a, l) => a + l.usd, 0), lines, unpriced: [...new Set(un.map((l) => l.m))], unpricedShare: tot ? un.reduce((a, l) => a + l.tokens, 0) / tot : 0, fast: usage.some((u) => /fast/i.test(u.m)) };
}
