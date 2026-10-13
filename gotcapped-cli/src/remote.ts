// Talking to gotcapped.com beyond the upload: deleting this device's data and reading crowd medians. Shared with the tray.
import type { State } from "./util";
import { VERSION } from "./util";
export const baseOf = (endpoint: string) => endpoint.replace(/\/api\/ingest\/?$/, "");
export async function deleteRemote(endpoint: string, s: Pick<State, "device" | "secret">, ua = `gotcapped/${VERSION}`) {
  const res = await fetch(`${baseOf(endpoint)}/api/ingest?device=${s.device}`, { method: "DELETE", headers: { "x-device-secret": s.secret, "user-agent": ua } });
  const j: any = await res.json().catch(() => ({}));
  return { ok: res.ok && !!j.ok, status: res.status, deleted: j.deleted ?? 0, error: j.error as string | undefined };
}
export type Crowd = { plan: string; kind: string; median: number | null; n: number; need: number; early: boolean; prevMedian: number | null; prevN: number };
export async function fetchCrowd(endpoint: string, kind: "weekly" | "5h" = "weekly", ua = `gotcapped/${VERSION}`): Promise<Crowd[]> {
  const res = await fetch(`${baseOf(endpoint)}/api/ingest/crowd?kind=${kind}`, { headers: { "user-agent": ua } });
  const j: any = await res.json().catch(() => ({}));
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j.plans ?? [];
}
