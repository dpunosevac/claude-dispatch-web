import * as C from "./crypto.js";
import * as DB from "./db.js";
import { parseCommand } from "./command.js";
import { parseSetup } from "./setup.js";

const STATE_RANK = { sent: 0, queued: 1, started: 2 };
const TERMINAL = new Set(["done", "failed", "cancelled", "busy_rejected"]);
const REPLYABLE = new Set(["needs_input", "done", "failed"]);
const CANCELLABLE = new Set(["sent", "queued", "started", "needs_input"]);

const S = {
  settings: null, // {server, req, res}
  key: null, // CryptoKey
  jobs: new Map(),
  machines: new Map(),
  seen: new Set(),
  lastId: null,
  lastRecv: 0,
  opened: 0,
  failed: 0,
  online: false,
  es: null,
  backoff: 1000,
  composeError: "",
  composeChoices: null,
  pending: null,
  importing: null, // parsed setup code awaiting confirmation
};

const $ = (sel) => document.querySelector(sel);
const app = () => $("#app");

/** Builds DOM nodes. All text goes through textContent; nothing is parsed as HTML. */
function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) {
    if (kid === null || kid === undefined || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

function ago(ts) {
  if (!ts) return "never";
  const d = Math.max(0, Math.floor(Date.now() / 1000) - ts);
  if (d < 60) return `${d}s ago`;
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}

const badge = (state) => h("span", { class: `badge s-${state || "unknown"}` }, (state || "?").replace("_", " "));
const topicUrl = (topic) => `${S.settings.server.replace(/\/+$/, "")}/${topic}`;

// ---------- persistence ----------

async function saveJob(j) {
  S.jobs.set(j.job, j);
  await DB.put("jobs", j);
}

async function mergeTurn(job, turn, fields) {
  const cur = (await DB.get("turns", [job, turn])) || { job, turn };
  const next = { ...cur };
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null) next[k] = v;
  await DB.put("turns", next);
  return next;
}

/** Orders updates for one job so late or replayed messages never move it backwards. */
function orderKey(turn, ts, state) {
  return [turn ?? 0, ts ?? 0, STATE_RANK[state] ?? 3];
}
function newer(a, b) {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return true;
}

// ---------- incoming messages ----------

async function handleMessage(m) {
  if (S.seen.has(m.id)) return;
  S.seen.add(m.id);
  if (m.type === "status") return onStatus(m);
  if (m.type === "result") return onResult(m);
  if (m.type === "hello") return onHello(m);
  if (m.type === "history") return onHistory(m);
}

async function onStatus(m) {
  const cur = S.jobs.get(m.job) || { job: m.job, prompt: "", created: m.ts, turn: 0 };
  const key = orderKey(m.turn, m.ts, m.state);
  if (!cur.order || cur.local || newer(key, cur.order)) {
    Object.assign(cur, {
      machine: m.machine,
      work: m.work,
      state: m.state,
      turn: Math.max(cur.turn ?? 0, m.turn ?? 0),
      updated: m.ts,
      order: key,
      local: false,
    });
    if (m.session_id) cur.session_id = m.session_id;
    await saveJob(cur);
  }
  await mergeTurn(m.job, m.turn ?? 0, {
    state: m.state,
    ts: m.ts,
    summary: m.summary,
    question: m.question,
    cost_usd: m.cost_usd,
    duration_s: m.duration_s,
    error: m.error,
    attachment: m.attachment,
    input: (m.turn ?? 0) === 0 && cur.prompt ? cur.prompt : undefined,
  });
}

async function onResult(m) {
  await mergeTurn(m.job, m.turn, { full: m.result, input: m.input || undefined, log_tail: m.log_tail });
  const cur = S.jobs.get(m.job);
  if (cur && !cur.prompt && m.turn === 0 && m.input) {
    cur.prompt = m.input;
    await saveJob(cur);
  }
}

async function onHello(m) {
  const rec = { machine: m.machine, works: m.works || [], version: m.version, busy_jobs: m.busy_jobs || [], battery: m.battery, seen: m.ts };
  S.machines.set(m.machine, rec);
  await DB.put("machines", rec);
}

async function onHistory(m) {
  for (const j of m.jobs || []) {
    const cur = S.jobs.get(j.job);
    if (cur && !cur.local && (cur.updated ?? 0) >= j.updated) {
      if (!cur.prompt && j.prompt) await saveJob({ ...cur, prompt: j.prompt });
      continue;
    }
    const turn = Math.max(0, (j.turns || 1) - 1);
    await saveJob({
      ...(cur || {}),
      job: j.job,
      machine: m.machine,
      work: j.work,
      prompt: j.prompt,
      state: j.state,
      created: j.created,
      updated: j.updated,
      turn,
      order: orderKey(turn, j.updated, j.state),
      local: false,
    });
    await mergeTurn(j.job, 0, { input: j.prompt });
  }
}

async function openBody(body) {
  const looks = C.looksLikeEnvelope(typeof body === "string" ? body : new TextDecoder().decode(body), "res");
  const m = await C.open(S.key, "res", body);
  if (m) S.opened++;
  else if (looks) S.failed++;
  return m;
}

async function processEvent(ev) {
  if (ev.event !== "message") return;
  S.lastId = ev.id;
  S.lastRecv = Math.floor(Date.now() / 1000);
  const msgs = [];
  if (ev.message) msgs.push(await openBody(ev.message));
  if (ev.attachment?.url) {
    try {
      const r = await fetch(ev.attachment.url);
      if (r.ok) msgs.push(await openBody(new Uint8Array(await r.arrayBuffer())));
    } catch {
      // Expired or unreachable attachments can be re-requested with fetch_result.
    }
  }
  for (const m of msgs) if (m) await handleMessage(m);
  DB.put("kv", S.lastId, "lastId");
  DB.put("kv", S.lastRecv, "lastRecv");
}

// ---------- transport ----------

async function poll() {
  const r = await fetch(`${topicUrl(S.settings.res)}/json?poll=1&since=12h`);
  if (!r.ok) throw new Error(`poll failed: ${r.status}`);
  for (const line of (await r.text()).split("\n")) {
    if (!line.trim()) continue;
    try {
      await processEvent(JSON.parse(line));
    } catch {
      // ignore malformed lines
    }
  }
}

function connect() {
  if (S.es) S.es.close();
  const since = S.lastId || "12h";
  const es = new EventSource(`${topicUrl(S.settings.res)}/sse?since=${encodeURIComponent(since)}`);
  S.es = es;
  let chain = Promise.resolve();
  es.onopen = () => {
    S.online = true;
    S.backoff = 1000;
    renderStatusBar();
  };
  es.onmessage = (e) => {
    chain = chain.then(async () => {
      try {
        await processEvent(JSON.parse(e.data));
        scheduleRender();
      } catch {
        // drop
      }
    });
  };
  es.onerror = () => {
    S.online = false;
    renderStatusBar();
    es.close();
    if (S.es === es) S.es = null;
    setTimeout(() => {
      if (!S.es && S.settings) connect();
    }, S.backoff);
    S.backoff = Math.min(S.backoff * 2, 30000);
  };
}

async function publish(msg) {
  const env = await C.seal(S.key, "req", msg);
  const r = await fetch(topicUrl(S.settings.req), { method: "POST", body: env });
  if (!r.ok) throw new Error(`publish failed: ${r.status}`);
}

async function startFeed() {
  try {
    await poll();
  } catch (e) {
    toast(String(e.message || e));
  }
  scheduleRender();
  connect();
  if (!(await DB.get("kv", "historyRequested"))) {
    await DB.put("kv", true, "historyRequested");
    send(C.request("history", { limit: 50 }));
  }
  const lastPing = (await DB.get("kv", "lastPing")) || 0;
  if (!S.machines.size || Date.now() - lastPing > 3600_000) ping();
}

async function send(msg, okText) {
  try {
    await publish(msg);
    if (okText) toast(okText);
    return true;
  } catch (e) {
    toast(String(e.message || e));
    return false;
  }
}

function ping() {
  DB.put("kv", Date.now(), "lastPing");
  return send(C.request("ping"));
}

// ---------- actions ----------

async function runJob(prompt, work, target, line) {
  const job = C.randomHex(4);
  const fields = { job, work, prompt };
  if (target) fields.target = target;
  const now = Math.floor(Date.now() / 1000);
  await saveJob({ job, work, prompt, machine: target || "", state: "sent", turn: 0, created: now, updated: now, local: true });
  await mergeTurn(job, 0, { input: prompt, state: "sent", ts: now });
  const recent = ((await DB.get("kv", "recent")) || []).filter((r) => r !== line);
  recent.unshift(line);
  await DB.put("kv", recent.slice(0, 8), "recent");
  if (await send(C.request("run", fields))) location.hash = `#job=${job}`;
}

async function reply(j, text) {
  const turn = (j.turn ?? 0) + 1;
  const now = Math.floor(Date.now() / 1000);
  await mergeTurn(j.job, turn, { input: text, state: "sent", ts: now });
  await saveJob({ ...j, state: "sent", turn, local: true });
  await send(C.request("reply", { job: j.job, text }), "Reply sent");
  render();
}

// ---------- views ----------

let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const a = document.activeElement;
    // Don't rebuild the view under someone typing.
    if (a && (a.tagName === "TEXTAREA" || a.tagName === "INPUT") && a.value) {
      renderStatusBar();
      return;
    }
    render();
  });
}

function toast(text) {
  const t = h("div", { class: "toast", role: "status" }, text);
  document.body.append(t);
  setTimeout(() => t.remove(), 3500);
}

function renderStatusBar() {
  const bar = $("#statusbar");
  if (!bar) return;
  bar.replaceChildren(
    h("span", { class: `dot ${S.online ? "on" : "off"}`, "aria-hidden": "true" }),
    h("span", {}, S.online ? "Live" : "Offline"),
    h("span", { class: "muted" }, ` · last message ${ago(S.lastRecv)}`),
  );
  const warn = $("#keywarn");
  if (warn) warn.hidden = !(S.failed >= 2 && S.opened === 0);
}

function nav() {
  const hash = location.hash;
  const tab = (href, label, active) => h("a", { href, class: active ? "tab active" : "tab", "aria-current": active ? "page" : null }, label);
  return h(
    "nav",
    { class: "nav" },
    tab("#", "Jobs", !hash || hash === "#" || hash.startsWith("#job=")),
    tab("#machines", "Machines", hash === "#machines"),
    tab("#setup", "Settings", hash === "#setup"),
  );
}

function shell(...content) {
  app().replaceChildren(
    nav(),
    h("div", { id: "statusbar", class: "statusbar" }),
    h("div", { id: "keywarn", class: "banner error", hidden: true }, "Messages are arriving but none decrypt. The key is probably wrong; re-enter it in Settings."),
    ...content,
  );
  renderStatusBar();
}

async function render() {
  if (S.importing) return renderImport();
  if (!S.settings || !S.key) return renderSetup(true);
  const hash = location.hash;
  if (hash === "#setup") return renderSetup(false);
  if (hash === "#machines") return renderMachines();
  if (hash.startsWith("#job=")) return renderJob(decodeURIComponent(hash.slice(5)));
  return renderJobs();
}

function knownMachines() {
  return [...S.machines.values()].sort((a, b) => a.machine.localeCompare(b.machine));
}

async function renderJobs() {
  const recent = (await DB.get("kv", "recent")) || [];
  const machines = knownMachines();
  const works = [...new Set(machines.flatMap((m) => m.works))].sort();
  const input = h("input", {
    id: "cmd",
    type: "text",
    inputmode: "text",
    autocapitalize: "off",
    autocomplete: "off",
    spellcheck: "false",
    placeholder: "/ship ABC-123 <work> @machine",
    "aria-label": "Command",
    value: S.pending?.line || "",
  });
  const appendToken = (tok) => {
    input.value = `${input.value.trim()} ${tok}`.trimStart() + " ";
    input.focus();
  };
  const submit = async (e, forcedTarget) => {
    e?.preventDefault();
    let line = input.value.trim();
    if (forcedTarget) line = `${line} @${forcedTarget}`;
    const p = parseCommand(line, machines);
    if (p.error) {
      S.composeError = p.error;
      S.composeChoices = p.choices || null;
      S.pending = { line: input.value.trim() };
      return render();
    }
    S.composeError = "";
    S.composeChoices = null;
    S.pending = null;
    await runJob(p.prompt, p.work, p.target, line);
  };

  const compose = h(
    "form",
    { class: "compose", onsubmit: submit },
    h("div", { class: "row" }, input, h("button", { class: "primary", type: "submit" }, "Run")),
    S.composeError ? h("div", { class: "error" }, S.composeError) : null,
    S.composeChoices
      ? h("div", { class: "chips" }, S.composeChoices.map((m) => h("button", { type: "button", class: "chip primary", onclick: (e) => submit(e, m) }, `Run on @${m}`)))
      : null,
    works.length || machines.length
      ? h(
          "div",
          { class: "chips" },
          works.map((w) => h("button", { type: "button", class: "chip", onclick: () => appendToken(w) }, w)),
          machines.map((m) => h("button", { type: "button", class: "chip alt", onclick: () => appendToken(`@${m.machine}`) }, `@${m.machine}`)),
        )
      : h("div", { class: "muted small" }, "No machines yet. Open Machines and ping."),
    recent.length
      ? h("div", { class: "chips" }, recent.map((r) => h("button", { type: "button", class: "chip ghost", onclick: () => { input.value = r; input.focus(); } }, r)))
      : null,
  );

  const jobs = [...S.jobs.values()].sort((a, b) => (b.updated ?? b.created ?? 0) - (a.updated ?? a.created ?? 0));
  const list = h(
    "ul",
    { class: "jobs" },
    jobs.length
      ? jobs.map((j) =>
          h(
            "li",
            {},
            h(
              "a",
              { href: `#job=${encodeURIComponent(j.job)}`, class: `job ${j.state === "needs_input" ? "attn" : ""}` },
              h("div", { class: "jrow" }, badge(j.state), h("span", { class: "muted small" }, ago(j.updated ?? j.created))),
              h("div", { class: "prompt" }, j.prompt || `(job ${j.job})`),
              h("div", { class: "muted small" }, [j.work, j.machine && `@${j.machine}`].filter(Boolean).join(" ")),
            ),
          ),
        )
      : h("li", { class: "muted empty" }, "No jobs yet."),
  );
  shell(
    compose,
    h(
      "div",
      { class: "section-head" },
      h("h2", {}, "Jobs"),
      h("button", { class: "small-btn", onclick: () => send(C.request("history", { limit: 50 }), "History requested") }, "Refresh history"),
    ),
    list,
  );
}

async function renderJob(id) {
  const j = S.jobs.get(id);
  if (!j) {
    shell(h("div", { class: "card" }, h("p", {}, `Waiting for job ${id}…`), h("a", { href: "#" }, "Back to jobs")));
    return;
  }
  const turns = (await DB.turnsFor(id)).sort((a, b) => a.turn - b.turn);
  const totalCost = turns.reduce((s, t) => s + (t.cost_usd || 0), 0);

  const thread = h(
    "div",
    { class: "thread" },
    turns.map((t) => {
      const body = t.full ?? t.question ?? t.summary;
      const truncated = t.full === undefined && (t.attachment || (body && body.endsWith("…")));
      return h(
        "div",
        { class: "turn" },
        t.input ? h("div", { class: "bubble me" }, h("div", { class: "who" }, t.turn === 0 ? "Prompt" : "You"), h("div", { class: "text" }, t.input)) : null,
        h(
          "div",
          { class: `bubble claude ${t.state === "needs_input" ? "question" : ""}` },
          h("div", { class: "who" }, "Claude ", badge(t.state)),
          body ? h("div", { class: "text" }, body) : h("div", { class: "muted" }, TERMINAL.has(t.state) || t.state === "needs_input" ? "(no output)" : "Working…"),
          t.error ? h("div", { class: "error" }, t.error) : null,
          h(
            "div",
            { class: "meta" },
            [t.duration_s != null && `${Math.round(t.duration_s)}s`, t.cost_usd != null && `$${t.cost_usd.toFixed(2)}`, t.ts && ago(t.ts)].filter(Boolean).join(" · "),
          ),
          truncated || (TERMINAL.has(t.state) && !t.full && body)
            ? h("button", { class: "small-btn", onclick: () => send(C.request("fetch_result", { job: id, turn: t.turn }), "Requested full result") }, truncated ? "Load full result" : "Reload result")
            : null,
          t.log_tail ? h("details", {}, h("summary", {}, "stderr tail"), h("pre", {}, t.log_tail)) : null,
        ),
      );
    }),
  );

  const replyBox = REPLYABLE.has(j.state)
    ? (() => {
        const ta = h("textarea", { rows: 3, placeholder: j.state === "needs_input" ? "Answer Claude…" : "Continue this session…", "aria-label": "Reply" });
        return h(
          "form",
          {
            class: "reply",
            onsubmit: async (e) => {
              e.preventDefault();
              const text = ta.value.trim();
              if (!text) return;
              ta.value = "";
              await reply(j, text);
            },
          },
          ta,
          h("button", { class: "primary", type: "submit" }, "Send reply"),
        );
      })()
    : null;

  const lastQ = j.state === "needs_input" ? turns.filter((t) => t.state === "needs_input").pop() : null;
  shell(
    h(
      "div",
      { class: "card head" },
      h("a", { href: "#", class: "back" }, "‹ Jobs"),
      h("div", { class: "jrow" }, badge(j.state), h("span", { class: "muted small" }, ago(j.updated ?? j.created))),
      h("h2", { class: "prompt" }, j.prompt || `(job ${j.job})`),
      h("div", { class: "muted small" }, [j.work, j.machine && `@${j.machine}`, `job ${j.job}`, totalCost && `$${totalCost.toFixed(2)}`].filter(Boolean).join(" · ")),
      lastQ ? h("div", { class: "banner attn" }, h("strong", {}, "Claude is asking: "), lastQ.question || lastQ.summary || "see below") : null,
      h(
        "div",
        { class: "actions" },
        CANCELLABLE.has(j.state)
          ? h("button", { class: "danger", onclick: () => confirm("Cancel this job?") && send(C.request("cancel", { job: j.job }), "Cancel sent") }, "Cancel")
          : null,
        h("button", { onclick: () => send(C.request("fetch_result", { job: j.job }), "Requested full result") }, "Load full result"),
      ),
    ),
    thread,
    replyBox,
  );
}

function renderMachines() {
  const ms = knownMachines();
  shell(
    h("div", { class: "section-head" }, h("h2", {}, "Machines"), h("button", { class: "primary", onclick: () => ping().then((ok) => ok && toast("Ping sent")) }, "Ping")),
    ms.length
      ? h(
          "ul",
          { class: "machines" },
          ms.map((m) => {
            const low = m.battery && !m.battery.charging && m.battery.pct < 20;
            return h(
              "li",
              { class: "card" },
              h("div", { class: "jrow" }, h("strong", {}, m.machine), h("span", { class: "muted small" }, ago(m.seen))),
              h("div", { class: "chips" }, (m.works || []).map((w) => h("span", { class: "chip static" }, w))),
              h(
                "div",
                { class: "muted small" },
                [
                  m.busy_jobs?.length ? `busy: ${m.busy_jobs.join(", ")}` : "idle",
                  m.battery && `battery ${m.battery.pct}%${m.battery.charging ? " (AC)" : ""}`,
                  m.version && `v${m.version}`,
                ]
                  .filter(Boolean)
                  .join(" · "),
              ),
              low ? h("div", { class: "error" }, "Battery low") : null,
            );
          }),
        )
      : h("p", { class: "muted" }, "No replies yet. Press Ping."),
  );
}

/** Validates and stores settings plus an optional new key, then (re)starts the feed. */
async function applySettings(settings, keyText) {
  if (!settings.server.startsWith("https://") || !settings.req || !settings.res || settings.req === settings.res) {
    throw new Error("Server must be https and topics must be set and differ");
  }
  if (keyText) {
    S.key = await C.importKey(keyText);
    await DB.put("kv", S.key, "key");
  } else if (!S.key) {
    throw new Error("Key is required");
  }
  const changed = JSON.stringify(settings) !== JSON.stringify(S.settings);
  if (changed && S.settings) {
    // Cached jobs and machines belong to the old topics.
    await DB.clearStores(["jobs", "turns", "machines"]);
    S.jobs.clear();
    S.machines.clear();
    S.seen.clear();
  }
  S.settings = settings;
  await DB.put("kv", settings, "settings");
  S.opened = S.failed = 0;
  if (changed) {
    S.lastId = null;
    await DB.put("kv", false, "historyRequested");
  }
  toast("Saved");
  location.hash = "#";
  await render();
  startFeed();
}

function beginImport(text) {
  const sc = parseSetup(text);
  if (!sc) {
    toast("That is not a valid setup code");
    return false;
  }
  S.importing = sc;
  render();
  return true;
}

/** Confirmation step, so a link someone sends you cannot silently replace your key and topics. */
function renderImport() {
  const sc = S.importing;
  const replacing = S.settings && S.key && (sc.server !== S.settings.server || sc.req !== S.settings.req || sc.res !== S.settings.res);
  const row = (k, v) => h("div", { class: "kvrow" }, h("span", { class: "muted small" }, k), h("code", {}, v));
  app().replaceChildren(
    h(
      "div",
      { class: "card setup" },
      h("h2", {}, "Import setup?"),
      h("p", { class: "muted small" }, "Only continue if this came from your own `cdispatch pair`."),
      row("Server", sc.server),
      row("Request topic", sc.req),
      row("Response topic", sc.res),
      row("Key", "•••••••• (43 characters)"),
      replacing ? h("div", { class: "banner error" }, "This replaces the key and topics currently on this device.") : null,
      h(
        "div",
        { class: "actions" },
        h(
          "button",
          {
            class: "primary",
            onclick: async () => {
              S.importing = null;
              try {
                await applySettings({ server: sc.server, req: sc.req, res: sc.res }, sc.key);
              } catch (err) {
                toast(String(err.message || err));
                render();
              }
            },
          },
          "Import",
        ),
        h(
          "button",
          {
            onclick: () => {
              S.importing = null;
              render();
            },
          },
          "Cancel",
        ),
      ),
    ),
  );
}

function loadJsQR() {
  if (window.jsQR) return Promise.resolve(window.jsQR);
  return new Promise((resolve, reject) => {
    const sc = document.createElement("script");
    sc.src = "vendor/jsQR.js";
    sc.onload = () => resolve(window.jsQR);
    sc.onerror = () => reject(new Error("Could not load the QR scanner"));
    document.head.append(sc);
  });
}

/** Full-screen camera view that decodes QR codes until it finds a setup code. */
async function scanSetup() {
  let stream;
  const video = h("video", { playsinline: true, muted: true, autoplay: true });
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  let done = false;
  const close = () => {
    done = true;
    stream?.getTracks().forEach((t) => t.stop());
    overlay.remove();
  };
  const overlay = h(
    "div",
    { class: "scanner", role: "dialog", "aria-label": "Scan setup QR" },
    video,
    h("div", { class: "scanframe", "aria-hidden": "true" }),
    h("p", {}, "Point the camera at the QR from `cdispatch pair`"),
    h("button", { onclick: close }, "Cancel"),
  );
  document.body.append(overlay);
  try {
    const [jsQR, s] = await Promise.all([
      loadJsQR(),
      navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false }),
    ]);
    stream = s;
    if (done) return close();
    video.srcObject = stream;
    await video.play();
    const tick = () => {
      if (done) return;
      const w = video.videoWidth, hgt = video.videoHeight;
      if (w && hgt) {
        const scale = Math.min(1, 720 / Math.max(w, hgt));
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(hgt * scale);
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const r = jsQR(img.data, img.width, img.height, { inversionAttempts: "attemptBoth" });
        if (r && parseSetup(r.data)) {
          close();
          beginImport(r.data);
          return;
        }
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (err) {
    close();
    toast(err.name === "NotAllowedError" ? "Camera permission denied" : String(err.message || err));
  }
}

function renderSetup(first) {
  const s = S.settings || { server: "https://ntfy.sh", req: "", res: "" };
  const field = (label, name, value, type = "text", extra = {}) =>
    h("label", { class: "field" }, h("span", {}, label), h("input", { name, type, value, autocomplete: "off", autocapitalize: "off", spellcheck: "false", ...extra }));
  const canScan = !!navigator.mediaDevices?.getUserMedia;
  const paste = h("input", { type: "password", placeholder: "Paste setup link", autocomplete: "off", "aria-label": "Setup link" });
  const quick = h(
    "div",
    { class: "card setup" },
    h("h2", {}, first ? "Set up claude-dispatch" : "Settings"),
    h("p", { class: "muted small" }, "On a Mac run `cdispatch pair`, then scan its QR here. The key is stored on this device as a non-extractable WebCrypto key."),
    canScan ? h("button", { class: "primary", onclick: scanSetup }, "Scan setup QR") : null,
    h(
      "form",
      {
        class: "row",
        onsubmit: (e) => {
          e.preventDefault();
          const v = paste.value;
          paste.value = "";
          beginImport(v);
        },
      },
      paste,
      h("button", { type: "submit" }, "Use"),
    ),
  );
  const form = h(
    "form",
    {
      class: "setup",
      onsubmit: async (e) => {
        e.preventDefault();
        const f = new FormData(e.target);
        const settings = {
          server: String(f.get("server")).trim().replace(/\/+$/, ""),
          req: String(f.get("req")).trim(),
          res: String(f.get("res")).trim(),
        };
        const keyText = String(f.get("key")).trim();
        e.target.elements.key.value = "";
        try {
          await applySettings(settings, keyText);
        } catch (err) {
          toast(String(err.message || err));
        }
      },
    },
    field("Server", "server", s.server, "url"),
    field("Request topic (REQ_TOPIC)", "req", s.req),
    field("Response topic (RES_TOPIC)", "res", s.res),
    field("Key", "key", "", "password", { placeholder: S.key ? "(unchanged)" : "43-character key", required: !S.key }),
    h("button", { class: "primary", type: "submit" }, "Save"),
  );
  const manual = h("details", { class: "card", open: !first && !!S.settings }, h("summary", {}, "Enter values manually"), form);
  const danger = first
    ? null
    : h(
        "div",
        { class: "card" },
        h("h3", {}, "Local data"),
        h("p", { class: "muted small" }, "Removes the key, settings and cached jobs from this device."),
        h(
          "button",
          {
            class: "danger",
            onclick: async () => {
              if (!confirm("Erase key, settings and cached jobs from this device?")) return;
              S.es?.close();
              await DB.clearAll();
              location.hash = "";
              location.reload();
            },
          },
          "Erase this device",
        ),
      );
  if (first) app().replaceChildren(quick, manual);
  else shell(quick, manual, danger);
}

/** Moves a `#setup=` fragment into memory and strips it from the URL and history entry. */
function takeSetupFromUrl() {
  if (!location.hash.startsWith("#setup=")) return false;
  const text = location.hash;
  history.replaceState(null, "", location.pathname + location.search);
  S.importing = parseSetup(text);
  if (!S.importing) toast("That setup link is not valid");
  return true;
}

// ---------- boot ----------

async function boot() {
  await DB.openDb();
  S.settings = (await DB.get("kv", "settings")) || null;
  S.key = (await DB.get("kv", "key")) || null;
  S.lastId = (await DB.get("kv", "lastId")) || null;
  S.lastRecv = (await DB.get("kv", "lastRecv")) || 0;
  for (const j of await DB.all("jobs")) S.jobs.set(j.job, j);
  for (const m of await DB.all("machines")) S.machines.set(m.machine, m);
  takeSetupFromUrl();
  window.addEventListener("hashchange", () => {
    takeSetupFromUrl();
    render();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && S.settings && S.key && !S.es) connect();
  });
  setInterval(renderStatusBar, 15000);
  await render();
  if (S.settings && S.key) startFeed();
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("./sw.js").catch(() => {});
}

boot().catch((e) => {
  app().replaceChildren(h("div", { class: "banner error" }, `Failed to start: ${e.message || e}`));
});
