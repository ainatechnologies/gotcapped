// §17 sign-in-change attribution. Every token entry is attributed to the account that was active in its config dir at
// that moment, using the local timeline of samples (statusline hook, every CLI run, every minute in --watch).
import type { Sample } from "./util";
export type Attr = { account: string | null; how: "observed" | "inferred" | "ambiguous" };
export const SWITCH_GUARD = 60e3;

export function attributor(timeline: Sample[], vendor: string, dir: string) {
  const s = timeline.filter((x) => x.vendor === vendor && x.dir === dir).sort((a, b) => a.t - b.t);
  const switches = s.filter((x, i) => i > 0 && x.account !== s[i - 1].account);
  const distinct = new Set(s.map((x) => x.account));
  return (t: number): Attr => {
    if (!s.length) return { account: null, how: "ambiguous" };
    // Within ±60 s of a detected switch: drop.
    if (switches.some((w) => Math.abs(w.t - t) <= SWITCH_GUARD)) return { account: null, how: "ambiguous" };
    let lo = -1; for (let i = 0; i < s.length; i++) if (s[i].t <= t) lo = i; else break;
    const prev = lo >= 0 ? s[lo] : null, next = lo + 1 < s.length ? s[lo + 1] : null;
    if (prev && next) return prev.account === next.account ? { account: prev.account, how: "observed" } : { account: null, how: "ambiguous" };
    if (prev) return { account: prev.account, how: "observed" }; // after the last sample; the last sample is taken at scan time
    // Before the first sample we ever took: only trust it when this dir has only ever shown one account.
    return distinct.size === 1 ? { account: next!.account, how: "inferred" } : { account: null, how: "ambiguous" };
  };
}
