// Got Capped tray UI. Plain JS, no framework, no remote code. Talks to the Rust core over Tauri IPC only.
const T = window.__TAURI__;
const invoke = T ? (c, a) => T.core.invoke(c, a) : async (c) => (c === "get_state" ? (await fetch("fixture-state.json")).json() : { ok: true });
const $ = (s) => document.querySelector(s);
let S = null, view = location.hash.slice(1) || null;
const money = (v) => v == null || !isFinite(v) ? "–" : v >= 1000 ? `$${(v / 1000).toFixed(v >= 1e4 ? 0 : 1)}k` : v >= 100 ? `$${Math.round(v)}` : `$${v.toFixed(v >= 10 ? 0 : 2)}`;
const tok = (n) => n >= 1e9 ? (n / 1e9).toFixed(1) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n >= 1e3 ? Math.round(n / 1e3) + "k" : String(n);
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
function left(iso) { let m = Math.max(0, Math.round((Date.parse(iso) - Date.now()) / 6e4)); const d = Math.floor(m / 1440); m -= d * 1440; const h = Math.floor(m / 60); m -= h * 60; return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`; }
const fillCls = (p) => (p >= 90 ? "max" : p >= 70 ? "hot" : "");

async function load() { S = await invoke("get_state"); if (S.startView && view == null && !load.done) view = S.startView; load.done = 1; render(); }
if (T) T.event.listen("state", (e) => { S = e.payload; render(); });
if (T) T.event.listen("account-switch", () => load());
setInterval(() => S && !view && render(), 30e3); // countdowns

function header(title) {
  const st = S.settings, cls = !st.optedIn ? "off" : st.paused ? "paused" : "", txt = !st.optedIn ? "Not sharing" : st.paused ? "Paused" : "Sharing numbers";
  return `<header><div class="mark"><div class="mk"><i></i></div>${title || "Got Capped"}</div><div class="sp"></div>
  ${view ? `<button class="ib" data-go="">Done</button>` : `<span class="status"><span class="dot ${cls}"></span>${txt}</span><button class="ib" data-go="settings" title="Settings">⚙</button>`}</header>`;
}
const fx = () => (S.fixture ? `<div class="fx">FIXTURE DATA · SYNTHETIC, NOT REAL USAGE</div>` : "");

function onboarding() {
  const st = S.settings;
  return `${header()}${fx()}<main>
  <h1>What does 100% <em>actually</em> buy?</h1>
  <p>Got Capped reads the token counts your AI tools already keep on this computer, prices them at public API rates, and divides by the bar % your plan shows. That's your plan's real value, every reset.</p>
  <div class="sec">If you turn sharing on, we send</div>
  <ul class="list"><li><span class="y">✓</span>Plan, window (5h / week), bar %, reset time</li><li><span class="y">✓</span>Token counts per model</li><li><span class="y">✓</span>A one-way hash of your account, so switching accounts can't mix numbers</li></ul>
  <div class="sec">We never send</div>
  <ul class="list"><li><span class="n">✕</span>Prompts, replies or code</li><li><span class="n">✕</span>File names, folders or project names</li><li><span class="n">✕</span>Emails, account IDs, session IDs or login tokens</li></ul>
  <div class="tog" data-act="toggle-opt"><div class="t"><b>Share my numbers with the public medians</b><span>Off by default. Everything works locally without it.</span></div><div class="sw ${st.optedIn ? "on" : ""}"></div></div>
  </main><footer><button class="ghost" data-go="payload">See the exact payload</button><div class="sp"></div><button class="acc" data-act="finish-onboarding">${st.optedIn ? "Start measuring" : "Measure locally only"}</button></footer>`;
}

function card(acc, rs) {
  const w = rs.find((r) => r.kind === "weekly"), h = rs.find((r) => r.kind === "5h"), lead = w || h;
  const bar = (r, l) => r ? `<div class="bar"><div class="lbl"><span>${l}</span><b>${Math.round(r.pct)}%</b></div><div class="track"><div class="fill ${fillCls(r.pct)}" style="width:${Math.min(100, r.pct)}%"></div></div><div class="rst">resets in ${left(r.resetAt)}</div></div>`
    : `<div class="bar"><div class="lbl"><span>${l}</span><b>–</b></div><div class="track"></div><div class="rst">no reading yet</div></div>`;
  let body = `<div class="empty">${acc.plan ? "Waiting for the first bar reading." : `Which plan is this? <a data-act="pick-plan" data-acct="${acc.account}" data-vendor="${acc.vendor}">Choose</a>`}</div>`;
  if (lead) {
    const mult = lead.planPrice && lead.usd ? ` · ${(lead.usd / lead.planPrice).toFixed(1)}× your $${lead.planPrice} so far` : "";
    const c = lead.crowd; let cmp = `<span class="k">vs crowd</span><span class="sub">median shows at 5 reports</span>`;
    if (c && c.median != null && lead.perBar) { const d = (lead.perBar - c.median) / c.median; cmp = `<span class="k">vs crowd</span><span class="sub">You: <b>${money(lead.perBar)}</b>/full bar · median <b>${money(c.median)}</b> (n=${c.n})${c.early ? " · early estimate" : ""}${c.prevMedian != null ? ` · last week <b>${money(c.prevMedian)}</b> (n=${c.prevN})` : ""}</span><span class="chip ${d >= 0 ? "up" : "dn"}">${d >= 0 ? "+" : ""}${Math.round(d * 100)}%</span>`; }
    else if (c) cmp = `<span class="k">vs crowd</span><span class="sub">You: <b>${money(lead.perBar)}</b>/full bar · ${c.need} more reports until the median shows</span>`;
    body = `<div class="big">${money(lead.usd)} <small>of API value ${lead.kind === "weekly" ? "this week" : "this 5h session"}</small></div>
    <div class="sub">${tok(lead.tokens)} tokens${mult}</div>
    <div class="bars">${bar(h, "5-hour")}${bar(w, "Weekly")}</div><div class="cmp">${cmp}</div>
    ${lead.note ? `<div class="note">${esc(lead.note)}</div>` : ""}${lead.attribution === "inferred" ? `<div class="note">Attribution inferred: no account switch seen since install.</div>` : ""}`;
  }
  return `<div class="card"><div class="top"><span class="plan">${esc(acc.planName || "Unknown plan")}</span><span class="acct">${acc.short}${acc.nick ? " · " + esc(acc.nick) : ""}</span><span class="tool">${acc.tool}</span></div>${body}</div>`;
}


function home() {
  const sc = S.scan, accs = sc.accounts || [];
  const cards = accs.map((a) => card(a, sc.readings.filter((r) => r.account === a.account))).join("") || `<div class="card empty">No Claude Code or Codex sign-in found on this computer yet. Install one, sign in with your plan, and this fills in by itself.</div>`;
  const cur = S.cursor;
  const cursor = cur && cur.ok ? `<div class="card"><div class="top"><span class="plan">Cursor</span><span class="acct">from CSV · ${cur.rows} rows</span><span class="tool">local only</span></div><div class="big">${money(cur.usd)} <small>of API value</small></div><div class="sub">Cursor billed <b>${money(cur.cursorSaid)}</b> of included usage · ${new Date(cur.from).toLocaleDateString()} – ${new Date(cur.to).toLocaleDateString()}</div><div class="note">Kept on this device in v0. <a data-act="cursor">Import a newer CSV</a></div></div>`
    : `<div class="drop" data-act="cursor">Using Cursor? Drop your usage CSV here<br><span style="font-size:11px">Dashboard → Usage → Export CSV. We never touch your Cursor login.</span></div>`;
  const hook = accs.some((a) => a.vendor === "claude") && !sc.hookInstalled ? `<div class="cut" style="background:#fff;border-color:var(--line);color:var(--ink2)"><span class="ic" style="color:var(--ink)">i</span><div>Claude Code bar % comes from its status line. <a data-act="install-hook">Turn on the status line hook</a> (local file only, keeps your current status line).</div></div>` : "";
  const skipped = (sc.skipped || []).filter((s) => !/status line hook/.test(s)).map((s) => `<div class="note">· ${esc(s)}</div>`).join("");
  return `${header()}${fx()}<main>${hook}${cards}${cursor}${skipped}</main>
  <footer><button class="ghost" data-act="rescan">Refresh</button><button class="ghost" data-go="payload">Payload</button><div class="sp"></div><button class="acc" data-ext="https://www.gotcapped.com">Open board</button></footer>`;
}

function hl(json) { return esc(json).replace(/(&quot;[^&]*?&quot;)(\s*:)?|\b(-?\d+\.?\d*)\b/g, (m, s, colon, n) => s ? `<span class="${colon ? "k" : "s"}">${s}</span>${colon || ""}` : `<span class="n">${n}</span>`); }
function payload() {
  const p = S.scan.preview, n = p.readings.length;
  return `${header("Exact payload")}${fx()}<main><p>${n ? `This is byte-for-byte what the next sync sends (${n} reading${n > 1 ? "s" : ""}). Request hashes are collapsed here; they're one-way hashes used only to drop duplicates.` : "Nothing to send yet."} ${S.settings.optedIn ? (S.settings.paused ? "Sharing is paused." : "Sent hourly.") : "Sharing is off, so nothing is sent."}</p>
  <pre>${hl(JSON.stringify(p, null, 2))}</pre><p class="note">Also saved locally as <span class="mono">~/.gotcapped/outbox/last.json</span>.</p></main>
  <footer><button class="ghost" data-act="copy">Copy JSON</button><div class="sp"></div><button data-go="">Done</button></footer>`;
}

function settings() {
  const st = S.settings, tog = (act, on, b, s) => `<div class="tog" data-act="${act}"><div class="t"><b>${b}</b><span>${s}</span></div><div class="sw ${on ? "on" : ""}"></div></div>`;
  return `${header("Settings")}${fx()}<main>
  ${tog("toggle-opt", st.optedIn, "Share my numbers", "Adds your readings to the public medians. Numbers only.")}
  ${tog("toggle-pause", st.paused, "Pause sharing", "Keeps measuring locally, sends nothing until you resume.")}
  ${tog("toggle-login", st.launchAtLogin, "Launch at login", "Starts quietly in the menu bar / tray.")}
  <div class="sec">Data</div>
  <div class="kv"><span>Device ID</span><b class="mono">${S.scan.device}…</b></div>
  <div class="kv"><span>Engine</span><b class="mono">${esc(S.scan.engine)}</b></div>
  <div class="kv"><span>Last scan</span><b class="mono">${new Date(S.scan.at).toLocaleTimeString()}</b></div>
  <div class="kv"><span>Last sync</span><b class="mono">${st.lastSync ? new Date(st.lastSync).toLocaleTimeString() : "never"}</b></div>
  <p class="note" style="margin-top:10px">Even with sharing off, the app fetches the public crowd medians from gotcapped.com at start and then hourly. Nothing about you is sent, but like any web request it reveals your IP address to our server (used only for rate limiting, stored only as a salted hash).</p>
  <p class="note" style="margin-top:10px"><a data-go="payload">See the exact payload</a> · <a data-ext="https://www.gotcapped.com/methodology">Privacy & method</a></p>
  <div class="sec">Delete</div>
  <p>Deletes everything on this computer and asks the server to remove every reading from this device.</p>
  <button class="danger" data-act="delete">Delete my data</button>${st.deleteMsg ? `<p class="note">${esc(st.deleteMsg)}</p>` : ""}
  </main><footer><button class="ghost" data-act="quit">Quit Got Capped</button><div class="sp"></div><button data-go="">Done</button></footer>`;
}

function render() {
  if (!S) return;
  const v = !S.settings.onboarded && view !== "payload" ? "onboarding" : view;
  $("#app").innerHTML = v === "onboarding" ? onboarding() : v === "payload" ? payload() : v === "settings" ? settings() : home();
}

document.addEventListener("click", async (e) => {
  const el = e.target.closest("[data-go],[data-act],[data-ext]"); if (!el) return;
  if (el.dataset.ext) return invoke("open_url", { url: el.dataset.ext });
  if ("go" in el.dataset) { view = el.dataset.go || null; return render(); }
  const a = el.dataset.act, st = S.settings, set = async (k, v) => { S = await invoke("set_setting", { key: k, value: v }); render(); };
  if (a === "toggle-opt") return set("optedIn", !st.optedIn);
  if (a === "toggle-pause") return set("paused", !st.paused);
  if (a === "toggle-login") return set("launchAtLogin", !st.launchAtLogin);
  if (a === "finish-onboarding") { view = null; return set("onboarded", true); }
  if (a === "rescan") { el.textContent = "Refreshing…"; S = await invoke("rescan"); return render(); }
  if (a === "install-hook") { S = await invoke("install_hook"); return render(); }
  if (a === "cursor") { S = await invoke("import_cursor", { path: null }); return render(); }
  if (a === "copy") { await navigator.clipboard.writeText(JSON.stringify(S.scan.payload, null, 2)); el.textContent = "Copied"; return; }
  if (a === "delete") { if (!confirm("Delete all Got Capped data on this computer and request deletion on the server?")) return; S = await invoke("delete_my_data"); view = null; return render(); }
  if (a === "quit") return invoke("quit");
  if (a === "pick-plan") { const opts = el.dataset.vendor === "claude" ? ["claude-pro", "claude-max-5x", "claude-max-20x"] : ["chatgpt-plus", "chatgpt-pro-100", "chatgpt-pro-200"];
    const p = prompt(`Plan for ${el.dataset.acct.slice(0, 8)}:\n${opts.map((o, i) => `${i + 1}. ${o}`).join("\n")}\n0. Team seat / other (keep local)`); if (p == null) return;
    S = await invoke("set_plan", { account: el.dataset.acct, plan: opts[Number(p) - 1] || "none" }); return render(); }
});
// Cursor CSV drag-and-drop (Tauri gives real file paths).
if (T) T.event.listen("tauri://drag-drop", async (e) => { const p = (e.payload.paths || []).find((x) => /\.csv$/i.test(x)); if (p) { S = await invoke("import_cursor", { path: p }); render(); } });
load();
