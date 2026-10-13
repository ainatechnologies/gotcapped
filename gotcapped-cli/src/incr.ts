// Incremental, streaming log scanner shared by the Claude and Codex readers.
// - Only files modified since `since` are opened (older files can't hold entries in the window).
// - Newest files first; read in 1 MB chunks, never a whole file in memory.
// - Lines are pre-filtered on raw bytes (Buffer.indexOf) so only usage lines get decoded and JSON-parsed.
// - Per-file cache (size, mtime, byte offset, parser state, entries in window) so later scans read only appended bytes.
import { openSync, readSync, closeSync, statSync, readFileSync, writeFileSync, renameSync } from "fs";
import { join } from "path";
import { ensureDir, home, hmac } from "./util";

export type FileCache<E, S> = { size: number; mtime: number; off: number; st: S; e: E[] };
type CacheDoc<E, S> = { v: 2; files: Record<string, FileCache<E, S>> };
const CHUNK = 4 << 20;

export function streamFile(path: string, from: number, marks: Buffer[], onLine: (s: string) => void): number {
  let fd: number; try { fd = openSync(path, "r"); } catch { return from; }
  const buf = Buffer.allocUnsafe(CHUNK); let carry: Buffer | null = null, pos = from, done = from;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, CHUNK, pos); if (n <= 0) break; pos += n;
      let data = buf.subarray(0, n); if (carry) { data = Buffer.concat([carry, data]); carry = null; }
      // Find marker hits across the whole chunk (memchr-speed) instead of walking every line; only hit lines are decoded.
      const end = data.lastIndexOf(10); const start = end + 1;
      if (end >= 0) {
        const hits: number[] = [];
        for (const m of marks) { let k = data.indexOf(m, 0); while (k >= 0 && k < end) { hits.push(k); k = data.indexOf(m, k + m.length); } }
        hits.sort((a, b) => a - b); let lastLine = -1;
        for (const h of hits) {
          const ls = data.lastIndexOf(10, h) + 1; if (ls === lastLine) continue; lastLine = ls;
          const le = data.indexOf(10, h); onLine(data.subarray(ls, le).toString("utf8"));
        }
      }
      done = pos - (data.length - start);
      // Keep an unfinished tail; if one "line" is absurdly long (>64 MB) drop it rather than grow memory.
      carry = start < data.length ? (data.length - start > 16 * CHUNK ? null : Buffer.from(data.subarray(start))) : null;
    }
  } finally { closeSync(fd); }
  return done; // offset just past the last complete line
}

export function cachePath(vendor: string, dir: string) { return join(ensureDir(join(home(), "cache")), `${vendor}-${hmac("dir:" + dir, 12)}.json`); }
export function loadCache<E, S>(p: string): CacheDoc<E, S> { try { const d = JSON.parse(readFileSync(p, "utf8")); if (d?.v === 2) return d; } catch {} return { v: 2, files: {} }; }
export function saveCache(p: string, d: unknown) { const t = p + ".tmp"; writeFileSync(t, JSON.stringify(d), { mode: 0o600 }); renameSync(t, p); }

// Generic driver. `fresh()` makes parser state, `parse(line, st)` returns entries (and mutates st).
export function scanIncremental<E extends { t: number }, S>(o: {
  files: string[]; since: number; cacheFile: string | null; save?: boolean; marks: string[];
  fresh: (file: string) => S; parse: (line: string, st: S, out: E[]) => void; budgetMs?: number;
}): { entries: E[]; complete: boolean; scanned: number; total: number } {
  const marks = o.marks.map((m) => Buffer.from(m));
  const cache = o.cacheFile ? loadCache<E, S>(o.cacheFile) : { v: 2 as const, files: {} as Record<string, FileCache<E, S>> };
  const stats = o.files.map((f) => { try { const s = statSync(f); return { f, size: s.size, mtime: s.mtimeMs }; } catch { return null; } })
    .filter((x): x is { f: string; size: number; mtime: number } => !!x && x.mtime >= o.since).sort((a, b) => b.mtime - a.mtime);
  const next: Record<string, FileCache<E, S>> = {}, t0 = Date.now(); let scanned = 0, complete = true;
  for (const s of stats) {
    let c = cache.files[s.f];
    if (c && c.size === s.size && c.mtime === s.mtime) { next[s.f] = c; scanned++; continue; }
    if (o.budgetMs != null && Date.now() - t0 > o.budgetMs) { complete = false; if (c) next[s.f] = c; continue; }
    if (!c || s.size < c.off) c = { size: 0, mtime: 0, off: 0, st: o.fresh(s.f), e: [] };
    const add: E[] = [];
    c.off = streamFile(s.f, c.off, marks, (l) => o.parse(l, c!.st, add));
    c.e = c.e.concat(add); c.size = s.size; c.mtime = s.mtime; next[s.f] = c; scanned++;
  }
  for (const k of Object.keys(next)) next[k].e = next[k].e.filter((e) => e.t >= o.since);
  if (o.cacheFile && o.save !== false) { const keep = { ...next }; for (const k of Object.keys(cache.files)) if (!(k in keep)) { const c = cache.files[k]; c.e = c.e.filter((e) => e.t >= o.since); if (c.e.length) keep[k] = c; } saveCache(o.cacheFile, { v: 2, files: keep }); }
  const entries: E[] = []; for (const k of Object.keys(next)) for (const e of next[k].e) entries.push(e);
  return { entries, complete, scanned, total: stats.length };
}
