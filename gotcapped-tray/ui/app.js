// Capped tray UI. Plain JS, no framework, no remote code. Talks to the Rust core over Tauri IPC only.
const T = window.__TAURI__;
const invoke = T ? (c, a) => T.core.invoke(c, a) : async (c) => (c === "get_state" ? (await fetch("fixture-state.json")).json() : { ok: true });
const $ = (s) => document.querySelector(s);
if (T && /Mac/.test(navigator.platform)) document.documentElement.classList.add("vib"); // native .menu vibrancy behind a transparent page
let S = null, view = location.hash.slice(1) || null;
const money = (v) => v == null || !isFinite(v) ? "–" : v >= 1000 ? `$${(v / 1000).toFixed(v >= 1e4 ? 0 : 1)}k` : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(v >= 10 ? 0 : 2)}`;
const tok = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function left(iso) { let m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 6e4)); const d = Math.floor(m / 1440); m -= d * 1440; const h = Math.floor(m / 60); m -= h * 60; return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
const fillCls = (p) => (p >= 90 ? "max" : p >= 70 ? "hot" : "");

async function load() { S = await invoke("get_state"); if (S.startView && view == null && !load.done) view = S.startView; load.done = 1; render(); }
if (T) T.event.listen("state", (e) => { S = e.payload; render(); });
if (T) T.event.listen("account-switch", () => load());
setInterval(() => S && !view && render(), 60e3); // live reset countdowns, once a minute while open

function header(title) {
  const st = S.settings, cls = !st.optedIn ? "off" : st.paused ? "paused" : "", txt = !st.optedIn ? "Not sharing" : st.paused ? "Paused" : "Sharing numbers";
  return `<header><div class="mark"><div class="mk"><i></i></div>${title || "Capped"}</div><div class="sp"></div>
  ${view ? `<button class="ib" data-go="">Done</button>` : `${(() => { const p = ((S.scan && S.scan.accounts) || []).filter((a) => a.planName).map((a) => a.planName).join(" · "); return p ? `<span class="status plan" title="Detected plans" style="max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p)}</span>` : ""; })()}<span class="status"><span class="dot ${cls}"></span>${txt}</span><button class="ib" data-go="settings" title="Settings">⚙</button>`}</header>`;
}
const fx = () => (S.fixture ? `<div class="tag">Sample data</div>` : ""); // C3: one small tag per view, no loud banner

// One-time notice (consent wording v1, /workspace/gotcapped-trust/consent-wording.md Variant A). Nothing is read before Agree.
function consent() {
  return `<header><div class="mark"><div class="mk"><i></i></div>Capped</div></header><main>
  <h1>Before we start</h1>
  <p>Capped shares anonymous usage numbers to build public, crowd-measured plan stats.</p>
  <p>It reads only token counts and usage-bar % from your local Claude Code and Codex logs, and sends: plan, reset window, bar %, tokens per model, app version, a random device ID and hashed account keys. Never your prompts, code, file names, email or raw IP.</p>
  <p>Run by AINA Technologies LLC (US). Data may be stored outside your country, kept up to 13 months, and published only as aggregates. You can delete it any time in Settings → Delete my data.</p>
  <p class="note">Details: <a data-ext="https://www.gotcapped.com/privacy">gotcapped.com/privacy</a> · hello@gotcapped.com</p>
  </main><footer><button class="ghost" data-act="cancel">Cancel</button><div class="sp"></div><button class="acc" data-act="agree">Agree and start sharing</button></footer>`;
}
function onboarding() {
  const st = S.settings;
  return `${header()}${fx()}<main>
  <h1>What does 100% <em>actually</em> buy?</h1>
  <p>Capped reads the token counts your AI tools already keep on this computer, prices them at public API rates, and divides by the bar % your plan shows. That's your plan's real value, every reset.</p>
  <div class="sec">If you turn sharing on, we send</div>
  <ul class="list"><li><span class="y">✓</span>Plan, window (5h / week), bar %, reset time</li><li><span class="y">✓</span>Token counts per model</li><li><span class="y">✓</span>A one-way hash of your account ID, never the ID itself</li></ul>
  <div class="sec">We never send</div>
  <ul class="list"><li><span class="n">✕</span>Prompts, replies or code</li><li><span class="n">✕</span>File names, folders or project names</li><li><span class="n">✕</span>Emails, account IDs, session IDs or login tokens</li></ul>
  <div class="tog" data-act="toggle-opt"><div class="t"><b>Share my numbers with the public medians</b><span>Off by default. Everything works locally without it.</span></div><div class="sw ${st.optedIn ? "on" : ""}"></div></div>
  </main><footer><span class="note" style="margin:0">Numbers only. Installing means you agree to <a data-ext="https://www.gotcapped.com/privacy">what we collect</a></span><div class="sp"></div><button class="acc" data-act="finish-onboarding">${st.optedIn ? "Start measuring" : "Measure locally only"}</button></footer>`;
}

const PLAN_PICK = {
  claude: [["claude-pro", "Pro"], ["claude-max-5x", "Max 5x"], ["claude-max-20x", "Max 20x"], ["claude-team-standard", "Team Standard"], ["claude-team-premium", "Team Premium"]],
  codex: [["chatgpt-plus", "Plus"], ["chatgpt-pro-100", "Pro $100"], ["chatgpt-pro-200", "Pro $200"]],
};
// Home = the popover drawn on www.gotcapped.com (C3): plan line, one big number, two bars, four token tiles, one footer row.
const resetAt = (iso) => { const d = new Date(iso); return `${d.toLocaleDateString("en-GB", { weekday: "short" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}`; };
const usd0 = (v) => v == null || !isFinite(v) ? "–" : `$${Math.round(v).toLocaleString("en-US")}`;
function card(acc, rs) {
  const w = rs.find((r) => r.kind === "weekly"), h = rs.find((r) => r.kind === "5h"), lead = w || h;
  const scanning = (S.scan.phase || "full") !== "full";
  const bar = (r, l, hot) => `<div class="pm-row"><span>${l}</span><span class="mono">${r ? Math.round(r.pct) + "%" : "–"}</span></div><div class="pm"><i class="${hot ? "hot" : ""}" style="width:${r ? Math.min(100, r.pct) : 0}%"></i></div>`;
  if (!acc.plan) {
    const picks = (PLAN_PICK[acc.vendor] || []).map(([id, l]) => `<button class="ghost sm" data-act="set-plan" data-acct="${acc.account}" data-plan="${id}">${l}</button>`).join("");
    return `<div class="p-plan">${esc(acc.tool)} · ${acc.seat ? `detected ${esc(acc.seat.replace(/_/g, " "))}` : "plan not detected"}</div><div class="p-ask">Which plan is this login on?</div><div class="picks">${picks}</div>`;
  }
  const line = `${esc(acc.planName)}${lead ? ` · resets ${resetAt(lead.resetAt)}` : ""}`;
  if (!lead) return `<div class="p-plan">${line}</div><div class="p-big"><b>–</b><span>per full week</span></div><div class="p-sub">${scanning ? "Reading your recent history…" : "Waiting for the first bar reading."}</div>${bar(w, "Weekly bar", true)}${bar(h, "5-hour session")}`;
  const c = lead.crowd, unit = lead.kind === "weekly" ? "week" : "session";
  const sub = `${usd0(lead.usd)} used so far${c && c.median != null ? ` · crowd median ${usd0(c.median)}` : c ? ` · crowd median at ${c.need} more` : ""}`;
  const t = lead.tk || {};
  const tile = (k, v) => `<div><span>${k}</span><b>${v != null ? tok(v) : "–"}</b></div>`;
  return `<div class="p-plan">${line}</div>
  <div class="p-big"><b>${usd0(lead.perBar ?? lead.usd)}</b><span>${lead.perBar ? `per full ${unit}` : `so far this ${unit}`}</span></div>
  <div class="p-sub">${sub}</div>
  ${bar(w, "Weekly bar", true)}${bar(h, "5-hour session")}
  <div class="tiles">${tile("Input", t.in)}${tile("Output", t.out)}${tile("Cache read", t.cr)}${tile("Cache write", t.cw)}</div>
  ${lead.note ? `<div class="note">${esc(lead.note)}</div>` : ""}`;
}

// Option A "Control Centre" (gotcapped-design/tray-premium/SPEC.md): one hairline-separated section per tool with real
// readings, a 22pt $ per full bar, Weekly (the only orange) and 5-hour bars, and a native-style footer menu.
// Live countdown, two largest units: "Resets in 6 days 4 hours", "Resets in 4 hours 12 minutes", "Resets in 10 minutes",
// then "Resets in under a minute". Re-rendered every minute while the popover is open.
const plural = (n, u) => `${n} ${u}${n === 1 ? "" : "s"}`;
function countdown(iso) {
  const m = Math.floor((Date.parse(iso) - Date.now()) / 6e4);
  if (!(m >= 1)) return "Resets in under a minute";
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mi = m % 60;
  const parts = d ? [plural(d, "day"), h ? plural(h, "hour") : ""] : h ? [plural(h, "hour"), mi ? plural(mi, "minute") : ""] : [plural(mi, "minute")];
  return `Resets in ${parts.filter(Boolean).join(" ")}`;
}
const resetLong = (r) => countdown(r.resetAt);
function sectionA(acc, rs) {
  const w = rs.find((r) => r.kind === "weekly"), h = rs.find((r) => r.kind === "5h"), lead = (w && w.perBar != null ? w : null) || (h && h.perBar != null ? h : null) || w || h;
  const loading = (S.scan.phase || "full") !== "full";
  const noCrowd = lead && !(lead.crowd && lead.crowd.median != null);
  const fig = lead ? usd0(lead.perBar ?? lead.usd) : "—", unit = lead && lead.perBar != null ? "per full bar" : "so far";
  const row = (r, l, cls) => r ? `<div class="a-row"><span>${l}</span><span class="a-sec">${Math.round(r.pct)}% · ${resetLong(r)}</span></div><div class="a-bar"><i class="${cls}" style="width:${Math.min(100, r.pct)}%"></i></div>` : "";
  return `<section class="a-tool"><div class="a-h"><b>${esc(acc.tool)}</b><span class="a-sec">${esc(acc.planName)}${noCrowd ? " · your estimate" : ""}</span></div>
  <div class="a-fig"><b class="${lead ? "" : "a-sec"}">${loading && !lead ? "—" : fig}</b><span class="a-sec">${unit}</span></div>${row(w, "Weekly", "wk")}${row(h, "5-hour", "fh")}</section>`;
}
function cursorA(c) {
  const d = (iso) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
  return `<section class="a-tool"><div class="a-h"><b>Cursor</b><span class="a-sec">imported CSV</span></div><div class="a-fig"><b>${usd0(c.usd)}</b><span class="a-sec">API value, ${d(c.from)} – ${d(c.to)}</span></div><div class="a-row"><span class="a-sec">No weekly or 5-hour bar to read</span></div></section>`;
}
const SEP = `<div class="a-sep"></div>`;
function home() {
  const sc = S.scan, accs = sc.accounts || [], st = S.settings;
  const rs = (a) => sc.readings.filter((r) => r.account === a.account);
  const top = (a) => Math.max(0, ...rs(a).map((r) => r.pct));
  const live = accs.filter((a) => a.plan && rs(a).length).sort((a, b) => top(b) - top(a)), cur = S.cursor && S.cursor.ok ? S.cursor : null;
  const ask = !live.length && accs.find((a) => !a.plan);
  const read = (live.length ? live : accs).map((a) => a.login).filter((v, i, x) => v && x.indexOf(v) === i).join(" and ");
  const tools = [...live.map((a) => sectionA(a, rs(a))), ...(cur ? [cursorA(cur)] : [])];
  const body = tools.length ? tools.join(SEP)
    : ask ? `<section class="a-tool">${card(ask, [])}</section>`
    : `<section class="a-tool"><div class="a-sec a-msg">${(sc.phase || "full") !== "full" ? "—" : accs.length ? `No usage bar read yet from the ${esc(read)}. It appears after your next prompt${accs.some((a) => a.vendor === "claude") && !sc.hookInstalled ? " once the Claude Code status line hook is on" : ""}.` : "No Claude Code or Codex sign-in found on this computer yet. Sign in with your plan and this fills in by itself."}</div></section>`;
  return `<div class="a-head"><b>Capped</b>${S.fixture ? `<span class="a-sec">• Sample data</span>` : ""}</div>${SEP}
  ${body}
  <div class="a-msep"></div><div class="a-menu"><div class="mi" data-go="settings">Settings…<span>⌘,</span></div><div class="mi" data-act="quit">Quit Capped<span>⌘Q</span></div></div>`;
}

function settings() {
  const st = S.settings, tog = (act, on, b, s) => `<div class="tog" data-act="${act}"><div class="t"><b>${b}</b><span>${s}</span></div><div class="sw ${on ? "on" : ""}"></div></div>`;
  return `${header("Settings")}${fx()}<main>
  ${tog("toggle-opt", st.optedIn, "Share my numbers", "Adds your readings to the public medians. Numbers only.")}
  ${tog("toggle-pause", st.paused, "Pause sharing", "Keeps measuring locally, sends nothing until you resume.")}
  ${tog("toggle-usd", st.showUsd, "Show $ in menu bar", "Plain text next to the icon. Off by default.")}
  ${tog("toggle-login", st.launchAtLogin, "Launch at login", "Starts quietly in the menu bar / tray.")}
  <div class="sec">What's read</div>
  ${(() => { const sc = S.scan || {}, accs = sc.accounts || [], cur = S.cursor && S.cursor.ok; const logins = accs.map((a) => a.login).filter((v, i, x) => v && x.indexOf(v) === i);
    return `<p class="note">${logins.length ? `Reading the ${esc(logins.join(" and "))}${cur ? " and your imported Cursor CSV" : ""}.` : "No Claude Code or Codex login found yet."}${sc.appSessions ? " Claude desktop app usage isn't included: its sign-in can't be read." : ""}</p>${accs.some((a) => a.vendor === "claude") && !sc.hookInstalled ? `<p class="note">Claude Code bar % comes from its status line. <a data-act="install-hook">Turn on the status line hook</a></p>` : ""}`; })()}
  <div class="sec">Data</div>
  <div class="kv"><span>Device ID</span><b class="mono">${S.scan.device}…</b></div>
  <div class="kv"><span>Engine</span><b class="mono">${esc(S.scan.engine)}</b></div>
  <div class="kv"><span>Last scan</span><b class="mono">${new Date(S.scan.at).toLocaleTimeString()}</b></div>
  <div class="kv"><span>Last sync</span><b class="mono">${st.lastSync ? new Date(st.lastSync).toLocaleTimeString() : "never"}</b></div>
  <p class="note" style="margin-top:10px">Even with sharing off, the app fetches the public crowd medians from gotcapped.com at start and then hourly. Nothing about you is sent, but like any web request it reveals your IP address to our server (used only for rate limiting, stored only as a salted hash).</p>
  <p class="note" style="margin-top:10px">Numbers only. Installing means you agree to <a data-ext="https://www.gotcapped.com/privacy">what we collect</a> · hello@gotcapped.com</p>
  <div class="sec">Other</div>
  <p><a data-ext="https://www.gotcapped.com">Open gotcapped.com</a> · <a data-act="rescan">Refresh now</a> · <a data-act="cursor">Import a Cursor usage CSV</a> <span class="note">(priced on this Mac only)</span></p>
  <div class="sec">Delete</div>
  <p>Deletes everything on this computer and asks the server to remove every reading from this device.</p>
  <button class="danger" data-act="delete">Delete my data</button>${st.deleteMsg ? `<p class="note">${esc(st.deleteMsg)}</p>` : ""}
  </main><footer><button class="ghost" data-act="quit">Quit Capped</button><div class="sp"></div><button data-go="">Done</button></footer>`;
}

function render() {
  if (!S) return;
  const v = !S.consent ? "consent" : !S.settings.onboarded ? "onboarding" : view;
  const app = $("#app"); app.className = v === "home" || !v ? "pop a" : "pop";
  app.innerHTML = v === "consent" ? consent() : v === "onboarding" ? onboarding() : v === "settings" ? settings() : home();
  // Option A: the window fits its content (about 440pt with two tools); other views keep a fixed height.
  if (T) requestAnimationFrame(() => invoke("fit_height", { h: !v ? Math.ceil(app.scrollHeight) : 480 }));
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-go],[data-act],[data-ext]"); if (!el) return;
  if (el.dataset.ext) return invoke("open_url", { url: el.dataset.ext });
  if ("go" in el.dataset) { view = el.dataset.go || null; return render(); }
  const a = el.dataset.act, st = S.settings, set = async (k, v) => { S = await invoke("set_setting", { key: k, value: v }); render(); };
  if (a === "toggle-opt") return set("optedIn", !st.optedIn);
  if (a === "toggle-pause") return set("paused", !st.paused);
  if (a === "toggle-usd") return set("showUsd", !st.showUsd);
  if (a === "toggle-login") return set("launchAtLogin", !st.launchAtLogin);
  if (a === "finish-onboarding") { view = null; return set("onboarded", true); }
  if (a === "rescan") { el.textContent = "Refreshing…"; S = await invoke("rescan"); return render(); }
  if (a === "install-hook") { S = await invoke("install_hook"); return render(); }
  if (a === "cursor") { S = await invoke("import_cursor", { path: null }); return render(); }
  if (a === "delete") { if (!confirm("Delete all Capped data on this computer and request deletion on the server?")) return; S = await invoke("delete_my_data"); view = null; return render(); }
  if (a === "quit" || a === "cancel") return invoke("quit");
  if (a === "agree") { el.textContent = "Starting…"; S = await invoke("agree"); view = null; return render(); }
  if (a === "set-plan") { el.textContent = "Saving…"; S = await invoke("set_plan", { account: el.dataset.acct, plan: el.dataset.plan }); return render(); }
});
// Cursor CSV drag-and-drop (Tauri gives real file paths).
if (T) T.event.listen("tauri://drag-drop", async (e) => { const p = (e.payload.paths || []).find((x) => /\.csv$/i.test(x)); if (p) { S = await invoke("import_cursor", { path: p }); render(); } });
// Native menu shortcuts: ⌘, opens Settings, ⌘Q quits.
document.addEventListener("keydown", (e) => { if (!e.metaKey) return; if (e.key === ",") { e.preventDefault(); view = "settings"; render(); } else if (e.key === "q") { e.preventDefault(); invoke("quit"); } });
load();
