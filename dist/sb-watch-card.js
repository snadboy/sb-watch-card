/*
 * SB Watch Card — entity + timeout rules on a dashboard.
 *
 * Lists the SB Watch rules that watch ONE entity being `on` for a while
 * (created here or in Settings), with a live "on for / off in" countdown, a
 * Paused toggle and delete per row, and an add row: pick an entity, give a
 * timeout, done. Creating, editing and deleting go through SB Watch's own
 * config/options flows (admin only) — the card holds no state of its own.
 *
 * A rule made here = notify the phone `warn_ahead` before the timeout, then
 * homeassistant.turn_off at the timeout (SB Watch "notify, then act").
 */
const VERSION = "0.3.1";
const CARD = "sb-watch-card";
const DUR_RX = /^(?:(\d+(?:\.\d+)?)\s*([dhms])\s*)+$|^\d+(?:\.\d+)?$/i;
const UNIT = { d: 86400, h: 3600, m: 60, s: 1 };

const esc = (v) => String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fire = (node, type, detail) => node.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
// "20", "20m", "1h30m", "2h" → seconds (a bare number is MINUTES, like SB Filter's state_for)
const parseDuration = (v) => {
  const s = String(v ?? "").trim();
  if (!s || !DUR_RX.test(s)) return null;
  if (/^[\d.]+$/.test(s)) return parseFloat(s) * 60;
  let secs = 0;
  for (const [, n, u] of s.matchAll(/([\d.]+)\s*([dhms])/gi)) secs += parseFloat(n) * UNIT[u.toLowerCase()];
  return secs;
};
const fmtDur = (secs) => {
  secs = Math.max(0, Math.round(secs));
  if (secs < 60) return `${secs} s`;
  const m = Math.round(secs / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
};
const toDurText = (secs) => { secs = Math.round(secs); if (secs % 60) return `${secs}s`; const m = secs / 60; return m % 60 === 0 && m >= 60 ? `${m / 60}h` : `${m}m`; };
const isEntityId = (s) => /^[a-z_]+\.[a-z0-9_]+$/.test(String(s || ""));

const DIALOG_STYLE = `
dialog.sbw-adddlg { border: none; border-radius: 12px; padding: 0; width: min(440px, 92vw); background: var(--card-background-color, #fff); color: var(--primary-text-color); box-shadow: 0 8px 32px rgba(0,0,0,.35); }
dialog.sbw-adddlg::backdrop { background: rgba(0,0,0,.45); }
dialog.sbw-adddlg .dh { display: flex; align-items: center; justify-content: space-between; padding: 14px 18px 8px; font-size: 1.1em; font-weight: 500; }
dialog.sbw-adddlg .dh .x { cursor: pointer; color: var(--secondary-text-color); background: none; border: none; font: inherit; }
dialog.sbw-adddlg .db { padding: 0 18px 8px; }
dialog.sbw-adddlg .df { display: flex; justify-content: flex-end; gap: 10px; padding: 8px 18px 16px; }
dialog.sbw-adddlg button { font: inherit; border: none; border-radius: 16px; padding: 8px 16px; cursor: pointer; }
dialog.sbw-adddlg .ok { background: var(--primary-color); color: var(--text-primary-color, #fff); }
dialog.sbw-adddlg .cancel { background: rgba(127,127,127,.15); color: var(--primary-text-color); }
dialog.sbw-adddlg .msg.err { padding: 6px 0 0; }
dialog.sbw-adddlg .msg { color: var(--secondary-text-color); font-size: .85em; }
dialog.sbw-adddlg .msg.err { color: var(--error-color); }
dialog.sbw-adddlg { font-family: var(--paper-font-body1_-_font-family, Roboto, sans-serif); }
`;

// HA lazy-loads ha-form with the card editors; force it in before we render the add row.
const loadHaForm = async () => {
  if (customElements.get("ha-form")) return true;
  try {
    const helpers = await window.loadCardHelpers();
    const card = helpers.createCardElement({ type: "entities", entities: [] });
    if (card?.constructor?.getConfigElement) await card.constructor.getConfigElement();
  } catch (e) { /* reported below */ }
  return !!customElements.get("ha-form");
};

class SbWatchCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._rules = [];          // [{entryId, name, entity, countId, activeId, pausedId, stateFor, warn, timeout, options}]
    this._regAt = 0;
    this._busy = false;
    this._error = null;
  }

  static getConfigElement() { return document.createElement("sb-watch-card-editor"); }
  static getStubConfig() { return { title: "Timeouts", notify_service: "", warn_ahead: "5m", domains: [] }; }

  setConfig(config) {
    this._config = { title: "Timeouts", warn_ahead: "5m", domains: [], ...config };
    if (this._hass) this._render();
  }
  getCardSize() { return 2 + this._rules.length; }

  set hass(hass) {
    const first = !this._hass;
    this._hass = hass;
    if (!this._config) return;
    if (first || Date.now() - this._regAt > 60000) this._loadRules();
    else if (this._sig() !== this._lastSig) this._render();
    if (this._form) this._form.hass = hass;
  }

  connectedCallback() { this._tick = setInterval(() => { if (this._hass) this._render(); }, 30000); }
  disconnectedCallback() { clearInterval(this._tick); if (this._dlg) { try { this._dlg.close(); } catch (e) { /* closed */ } this._dlg.remove(); this._dlg = null; } }

  _sig() {
    const h = this._hass;
    return this._rules.map((r) => { const s = h.states[r.entity], p = h.states[r.pausedId], c = h.states[r.countId]; return `${r.entryId}|${s?.state}|${s?.last_changed}|${p?.state}|${c?.state}`; }).join(";");
  }

  // ---- rules from the registry --------------------------------------------------
  async _loadRules() {
    this._regAt = Date.now();
    const conn = this._hass?.connection; if (!conn) return;
    let reg;
    try { reg = await conn.sendMessagePromise({ type: "config/entity_registry/list" }); }
    catch (e) { this._error = "Could not read the entity registry"; this._render(); return; }
    const byEntry = {};
    for (const e of reg) {
      if (e.platform !== "sb_watch" || !e.config_entry_id) continue;
      const r = (byEntry[e.config_entry_id] ||= { entryId: e.config_entry_id });
      if (e.entity_id.startsWith("sensor.")) r.countId = e.entity_id;
      else if (e.entity_id.startsWith("binary_sensor.")) r.activeId = e.entity_id;
      else if (e.entity_id.startsWith("switch.")) r.pausedId = e.entity_id;
    }
    const rules = [];
    for (const r of Object.values(byEntry)) {
      const st = this._hass.states[r.countId];
      const f = st?.attributes?.filter || {};
      const pats = Array.isArray(f.patterns) ? f.patterns : [];
      // a timeout rule: exactly one entity id, exactly one state value, a time-in-state
      if (pats.length !== 1 || !isEntityId(pats[0]) || !f.state_for) continue;
      if (!Array.isArray(f.states) || f.states.length !== 1) continue;
      if (f.labels || f.areas || f.device_classes || f.units || f.rate) continue;
      r.entity = pats[0];
      r.state = String(f.states[0]);
      r.stateFor = parseDuration(f.state_for) ?? 0;
      r.name = (st.attributes.friendly_name || "").replace(/\s*Count$/, "");
      rules.push(r);
    }
    // warn-ahead lives in the rule's options: read once per rule via diagnostics (admin)
    const known = new Map(this._rules.map((r) => [r.entryId, r.options]));
    await Promise.all(rules.map(async (r) => {
      if (known.has(r.entryId) && known.get(r.entryId)) { r.options = known.get(r.entryId); }
      else {
        try { const d = await this._hass.callApi("GET", `diagnostics/config_entry/${r.entryId}`); r.options = d?.data?.options || {}; }
        catch (e) { r.options = {}; }
      }
      const w = parseDuration(r.options.warn_ahead);
      r.warn = r.options.action === "notify_then_act" && w != null ? w : 0;
      r.acts = r.options.action === "notify_then_act" || r.options.action === "act";
      r.act = r.options.act || "turn_off";
      r.script = r.options.act_script || null;
      r.actions = Array.isArray(r.options.act_actions) ? r.options.act_actions : [];
      r.timeout = r.stateFor + r.warn;
    }));
    // translated state labels for the rows come from SB Filter's vocabulary, once per entity
    this._vocabCache = this._vocabCache || {};
    await Promise.all([...new Set(rules.map((r) => r.entity))].filter((e) => !this._vocabCache[e]).map(async (e) => {
      try { const r = await this._hass.connection.sendMessagePromise({ type: "sb_filter/values", config: { patterns: [e] } }); this._vocabCache[e] = r.values || []; }
      catch (err) { this._vocabCache[e] = []; }
    }));
    rules.sort((a, b) => (this._hass.states[a.entity]?.attributes?.friendly_name || a.entity).localeCompare(this._hass.states[b.entity]?.attributes?.friendly_name || b.entity));
    this._rules = rules;
    this._render();
  }

  // ---- create / edit / delete through SB Watch's flows ------------------------------
  // spec = { entity, state, timeoutSecs, actions:[HA action configs] }
  _actionsFor(spec) {
    const cfg = this._config, notify = (cfg.notify_service || "").trim();
    let warn = parseDuration(cfg.warn_ahead) ?? 300;
    warn = Math.min(warn, Math.floor(spec.timeoutSecs / 2));
    const acts = spec.actions && spec.actions.length
      ? { act: "run_actions", act_actions: spec.actions }
      : { act: "none" };                                        // nothing to run: notify only (or just track)
    const stateFor = notify && acts.act !== "none" ? spec.timeoutSecs - warn : spec.timeoutSecs;
    let actions;
    if (acts.act === "none") actions = notify ? { action: "notify", notify_service: notify, act: "turn_off", warn_ahead: "0" } : { action: "none", act: "turn_off", warn_ahead: "0" };
    else if (notify) actions = { action: "notify_then_act", notify_service: notify, warn_ahead: toDurText(warn), ...acts };
    else actions = { action: "act", warn_ahead: "0", ...acts };
    return { actions, stateFor };
  }

  async _createRule(spec) {
    const hass = this._hass;
    const st = hass.states[spec.entity];
    const name = `${st?.attributes?.friendly_name || spec.entity} ${this._stateLabel(spec.entity, spec.state)} timeout`;
    const { actions, stateFor } = this._actionsFor(spec);
    let flow;
    try { flow = await hass.callApi("POST", "config/config_entries/flow", { handler: "sb_watch" }); }
    catch (e) { throw new Error("SB Watch is not installed (or you are not an admin)"); }
    const s2 = await hass.callApi("POST", `config/config_entries/flow/${flow.flow_id}`, { name, patterns: spec.entity, state_for: toDurText(stateFor), problem: true });
    if (s2.step_id !== "values") throw new Error(s2.errors ? JSON.stringify(s2.errors) : `unexpected step ${s2.step_id}`);
    const done = await hass.callApi("POST", `config/config_entries/flow/${s2.flow_id}`, { states: [spec.state], actions });
    if (done.type !== "create_entry") throw new Error(done.errors ? Object.values(done.errors).join(", ") : `unexpected step ${done.step_id}`);
  }

  async _updateRule(rule, spec) {
    const hass = this._hass, o = rule.options || {};
    const { actions, stateFor } = this._actionsFor(spec);
    const st = hass.states[spec.entity];
    const step1 = { name: `${st?.attributes?.friendly_name || spec.entity} ${this._stateLabel(spec.entity, spec.state)} timeout`, patterns: spec.entity, state_for: toDurText(stateFor), problem: o.problem ?? true };
    const flow = await hass.callApi("POST", "config/config_entries/options/flow", { handler: rule.entryId });
    const s2 = await hass.callApi("POST", `config/config_entries/options/flow/${flow.flow_id}`, step1);
    if (s2.step_id !== "values") throw new Error(s2.errors ? JSON.stringify(s2.errors) : `unexpected step ${s2.step_id}`);
    const done = await hass.callApi("POST", `config/config_entries/options/flow/${s2.flow_id}`, { states: [spec.state], actions });
    if (done.type !== "create_entry") throw new Error(done.errors ? Object.values(done.errors).join(", ") : `unexpected step ${done.step_id}`);
    rule.options = null;
  }

  async _updateTimeout(rule, timeoutSecs) {
    await this._updateRule(rule, { entity: rule.entity, state: rule.state, timeoutSecs, actions: this._ruleActions(rule) });
  }

  // the rule's action list as HA action configs (older quick acts become one call)
  _ruleActions(rule) {
    if (rule.act === "run_actions") return rule.actions || [];
    if (rule.act === "run_script" && rule.script) return [{ action: "script.turn_on", target: { entity_id: rule.script }, data: { variables: { entity_id: rule.entity } } }];
    if (["turn_off", "turn_on", "toggle"].includes(rule.act) && rule.acts) return [{ action: `homeassistant.${rule.act}`, target: { entity_id: rule.entity } }];
    return [];
  }

  async _deleteRule(rule) {
    await this._hass.callApi("DELETE", `config/config_entries/entry/${rule.entryId}`);
  }

  // ---- render ---------------------------------------------------------------------
  _status(rule) {
    const st = this._hass.states[rule.entity];
    if (!st) return { text: "entity missing", cls: "bad" };
    const want = String(rule.state).toLowerCase();
    const label = this._stateLabel(rule.entity, rule.state);
    if (String(st.state).toLowerCase() !== want) return { text: `${this._stateLabel(rule.entity, st.state)} — watching for ${label}`, cls: "" };
    const on = (Date.now() - new Date(st.last_changed).getTime()) / 1000;
    const paused = this._hass.states[rule.pausedId]?.state === "on";
    const verb = this._verb(rule);
    if (paused) return { text: `${label} for ${fmtDur(on)} · paused`, cls: "paused" };
    const left = rule.timeout - on;
    if (left <= 0) return { text: `${label} for ${fmtDur(on)} · ${rule.acts ? `over the timeout — ${verb}` : "over the timeout (rule has no action)"}`, cls: "over" };
    if (rule.warn && on >= rule.stateFor) return { text: `${label} for ${fmtDur(on)} · ${verb} in ${fmtDur(left)} (notified)`, cls: "warn" };
    return { text: `${label} for ${fmtDur(on)} · ${verb} in ${fmtDur(left)}`, cls: "on" };
  }

  _stateLabel(entityId, raw) {
    const v = (this._vocabCache || {})[entityId];
    const hit = v && v.find((i) => String(i.value).toLowerCase() === String(raw).toLowerCase());
    return hit ? hit.label : raw;
  }
  _verb(rule) {
    if (!rule.acts) return "no action";
    if (rule.act === "run_actions") {
      const list = rule.actions || [];
      if (!list.length) return "no action";
      const first = list[0].action || list[0].service || "action";
      const svc = first.includes(".") ? first.split(".")[1].replace(/_/g, " ") : first;
      return list.length === 1 ? svc : `${svc} +${list.length - 1}`;
    }
    if (rule.act === "run_script") { const s = this._hass.states[rule.script]; return `run ${s?.attributes?.friendly_name || rule.script || "script"}`; }
    return { turn_off: "turn off", turn_on: "turn on", toggle: "toggle" }[rule.act] || "turn off";
  }
  _actGlyph(rule) { return { turn_off: "mdi:power-off", turn_on: "mdi:power-on", toggle: "mdi:swap-horizontal", run_script: "mdi:script-text-play-outline", run_actions: "mdi:play-box-multiple-outline" }[rule.acts ? rule.act : "none"] || "mdi:bell-outline"; }

  _render() {
    if (!this._hass || !this._config) return;
    // A rebuild replaces the whole shadow tree: with the Add dialog or a timeout
    // edit open that would dismiss it or yank focus. Defer, catch up on close.
    if (this._dlg || this._editing) { this._dirty = true; return; }
    this._dirty = false;
    this._lastSig = this._sig();
    const h = this._hass, cfg = this._config;
    const rows = this._rules.map((r) => {
      const st = h.states[r.entity]; const s = this._status(r);
      const paused = h.states[r.pausedId]?.state === "on";
      const name = st?.attributes?.friendly_name || r.entity;
      return `<div class="row ${s.cls}" data-e="${esc(r.entryId)}">
        <span class="ic" data-ent="${esc(r.entity)}"></span>
        <div class="body"><div class="name">${esc(name)}</div><div class="sub">${esc(s.text)}</div></div>
        <span class="to" title="Timeout — click to change">${esc(fmtDur(r.timeout))}${r.acts ? "" : " ⚠ no action"}</span>
        <ha-icon class="act" icon="${this._actGlyph(r)}" title="At the timeout: ${esc(this._verb(r))}"></ha-icon>
        <ha-icon class="btn edit" icon="mdi:pencil-outline" title="Edit entity, state, timeout or actions"></ha-icon>
        <ha-icon class="btn pause ${paused ? "on" : ""}" icon="${paused ? "mdi:play-circle-outline" : "mdi:pause-circle-outline"}" title="${paused ? "Resume" : "Pause (keep tracking, take no action)"}"></ha-icon>
        <ha-icon class="btn del" icon="mdi:delete-outline" title="Delete this rule"></ha-icon>
      </div>`;
    }).join("");
    this.shadowRoot.innerHTML = `<style>
      ha-card { padding: 12px 16px 10px; }
      .hdr { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
      .title { font-size: 1.2em; font-weight: 500; flex: 1; color: var(--primary-text-color); }
      .n { color: var(--secondary-text-color); font-size: .85em; }
      .row { display: flex; align-items: center; gap: 12px; padding: 8px 0; border-top: 1px solid var(--divider-color); }
      .row:first-of-type { border-top: none; }
      .ic { width: 24px; height: 24px; flex: none; color: var(--state-icon-color); }
      .body { flex: 1; min-width: 0; }
      .name { color: var(--primary-text-color); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .sub { color: var(--secondary-text-color); font-size: .85em; }
      .row.on .sub { color: var(--primary-color); }
      .row.warn .sub { color: var(--warning-color, orange); }
      .row.over .sub { color: var(--error-color); }
      .row.paused .sub { color: var(--secondary-text-color); font-style: italic; }
      .row.bad .sub { color: var(--error-color); }
      .to { font-size: .85em; padding: 3px 10px; border-radius: 12px; background: rgba(var(--rgb-primary-text-color, 0,0,0), .06); color: var(--primary-text-color); cursor: pointer; white-space: nowrap; }
      .to input { width: 5.5em; font: inherit; background: transparent; border: none; border-bottom: 1px solid var(--primary-color); color: inherit; outline: none; }
      .btn { cursor: pointer; color: var(--secondary-text-color); --mdc-icon-size: 22px; }
      .btn.pause.on { color: var(--warning-color, orange); }
      .btn.del:hover { color: var(--error-color); }
      .act { --mdc-icon-size: 18px; color: var(--secondary-text-color); }
      .addbtn { font: inherit; font-size: .9em; color: var(--primary-color); background: none; border: 1px solid var(--primary-color); border-radius: 16px; padding: 4px 12px 4px 8px; cursor: pointer; display: inline-flex; align-items: center; gap: 4px; }
      .addbtn ha-icon { --mdc-icon-size: 18px; }
      .addbtn[disabled] { opacity: .5; cursor: default; }
      .msg { color: var(--secondary-text-color); font-size: .85em; padding: 6px 0; }
      .msg.err { color: var(--error-color); }
      .empty { color: var(--secondary-text-color); font-style: italic; padding: 10px 0; }
    </style>
    <ha-card>
      <div class="hdr"><div class="title">${esc(cfg.title || "")}</div><div class="n">${this._rules.length} rule${this._rules.length === 1 ? "" : "s"}</div><button class="addbtn" ${this._busy ? "disabled" : ""}><ha-icon icon="mdi:plus"></ha-icon> Add</button></div>
      ${rows || `<div class="empty">No timeout rules yet — press Add.</div>`}
      ${this._error ? `<div class="msg err">${esc(this._error)}</div>` : this._msg ? `<div class="msg">${esc(this._msg)}</div>` : ""}
    </ha-card>`;
    // icons
    this.shadowRoot.querySelectorAll(".ic").forEach((ph) => { const st = h.states[ph.dataset.ent]; if (!st) return; const el = document.createElement("ha-state-icon"); el.hass = h; el.stateObj = st; el.className = "ic"; ph.replaceWith(el); });
    // row actions
    this.shadowRoot.querySelectorAll(".row").forEach((row) => {
      const rule = this._rules.find((r) => r.entryId === row.dataset.e); if (!rule) return;
      row.querySelector(".body").addEventListener("click", () => fire(this, "hass-more-info", { entityId: rule.entity }));
      row.querySelector(".edit").addEventListener("click", () => this._openDialog(rule));
      row.querySelector(".pause").addEventListener("click", () => this._hass.callService("switch", h.states[rule.pausedId]?.state === "on" ? "turn_off" : "turn_on", { entity_id: rule.pausedId }));
      row.querySelector(".del").addEventListener("click", () => this._run(`Deleting ${rule.name}…`, async () => { if (!confirm(`Delete the rule for ${h.states[rule.entity]?.attributes?.friendly_name || rule.entity}?`)) return; await this._deleteRule(rule); }, true));
      const to = row.querySelector(".to");
      to.addEventListener("click", () => {
        if (to.querySelector("input")) return;
        to.innerHTML = `<input value="${esc(toDurText(rule.timeout))}" placeholder="20m">`;
        const inp = to.querySelector("input"); inp.focus(); inp.select();
        this._editing = true;
        const done = () => { this._editing = false; };
        const commit = () => { done(); const secs = parseDuration(inp.value); if (secs == null || secs < 60) { this._error = "Timeout: e.g. 20m, 1h30m (at least 1 minute)"; this._render(); return; } this._run(`Changing ${rule.name}…`, () => this._updateTimeout(rule, secs), true); };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") { done(); this._render(); } });
        inp.addEventListener("blur", () => { if (this.shadowRoot.contains(inp)) commit(); });
      });
    });
    this.shadowRoot.querySelector(".addbtn").addEventListener("click", () => this._openDialog(null));
  }

  async _openDialog(rule) {
    if (!(await loadHaForm())) { this._error = "HA's form element did not load — open any card editor once and reload."; this._render(); return; }
    this.shadowRoot.querySelectorAll("dialog.sbw-adddlg").forEach((d) => d.remove());
    const d = document.createElement("dialog"); d.className = "sbw-adddlg";
    d.innerHTML = `<style>${DIALOG_STYLE}</style><div class="dh"><span>${rule ? "Edit timeout rule" : "Add a timeout rule"}</span><button class="x" title="Close">✕</button></div><div class="db"><div class="formbox"></div><div class="msg err" style="display:none"></div></div>
      <div class="df"><button class="cancel">Cancel</button><button class="ok">${rule ? "Save" : "Create rule"}</button></div>`;
    // Inside the card's shadow root, NOT document.body: HA's action/target editors
    // take their registries and states from Lit contexts provided by the app
    // element, and a dialog on document.body is outside that tree
    // (_checkTargetExists read an undefined _states). Re-renders can't disturb
    // it because _render() defers while this._dlg is set.
    this.shadowRoot.appendChild(d);
    this._dlg = d;
    const close = () => { try { d.close(); } catch (e) { /* closed */ } d.remove(); this._form = null; this._dlg = null; if (this._dirty) this._render(); };
    d.querySelector(".x").addEventListener("click", close); d.querySelector(".cancel").addEventListener("click", close);
    d.addEventListener("cancel", (e) => { e.preventDefault(); close(); });
    const h = this._hass;
    this._draft = rule
      ? { entity: rule.entity, state: rule.state, timeout: toDurText(rule.timeout), actions: this._ruleActions(rule) }
      : { entity: "", state: "", timeout: "", actions: [] };
    const box = d.querySelector(".formbox"), err = d.querySelector(".msg.err");
    let vocab = [];
    const fetchVocab = async (entityId) => {
      if (!entityId) { vocab = []; return; }
      try { const r = await h.connection.sendMessagePromise({ type: "sb_filter/values", config: { patterns: [entityId] } }); vocab = r.values || []; }
      catch (e) { vocab = []; }
      this._vocabCache = this._vocabCache || {}; this._vocabCache[entityId] = vocab;
    };
    const defaultActions = (entityId) => {
      const dom = entityId.split(".")[0];
      const offable = ["switch", "light", "fan", "climate", "humidifier", "media_player", "input_boolean", "remote", "siren", "valve", "automation", "script"];
      if (offable.includes(dom)) return [{ action: "homeassistant.turn_off", target: { entity_id: entityId } }];
      if (dom === "cover") return [{ action: "cover.close_cover", target: { entity_id: entityId } }];
      if (dom === "lock") return [{ action: "lock.lock", target: { entity_id: entityId } }];
      return [];
    };
    const build = () => {
      if (!box.isConnected) return;
      const dr = this._draft;
      const stateOpts = vocab.length
        ? vocab.map((v) => ({ value: String(v.value), label: v.label.toLowerCase() === String(v.value).toLowerCase() ? v.label : `${v.label} (${v.value})` }))
        : (dr.entity ? [{ value: String(h.states[dr.entity]?.state ?? ""), label: `${h.states[dr.entity]?.state ?? "?"} (current)` }] : []);
      const f = document.createElement("ha-form");
      f.hass = h;
      f.schema = [
        { name: "entity", selector: { entity: (this._config.domains || []).length ? { domain: this._config.domains } : {} } },
        ...(dr.entity ? [
          { name: "state", selector: { select: { mode: stateOpts.length <= 6 ? "list" : "dropdown", options: stateOpts, custom_value: true } } },
          { name: "timeout", selector: { text: {} } },
          { name: "actions", selector: { action: {} } },
        ] : []),
      ];
      f.computeLabel = (s) => ({ entity: "Entity to watch", state: "When it has been in this state", timeout: "for this long (e.g. 20m, 2h)", actions: "then run these actions" }[s.name]);
      f.computeHelper = (s) => ({
        timeout: this._config.notify_service ? `The phone is notified ${this._config.warn_ahead || "5m"} before the actions run.` : "No notify service on this card: the actions run at the timeout with no notice.",
        actions: "Leave empty to only notify / track. The actions get entity_id and rule as variables.",
      }[s.name]);
      f.data = dr;
      f.addEventListener("value-changed", async (e) => {
        e.stopPropagation();
        const prev = this._draft; const next = e.detail.value;
        if (next.entity !== prev.entity) {
          this._draft = { ...next, state: "", actions: next.entity ? defaultActions(next.entity) : [] };
          await fetchVocab(next.entity);
          const cur = h.states[next.entity]?.state;
          const known = vocab.find((v) => String(v.value).toLowerCase() === String(cur).toLowerCase());
          this._draft.state = known ? String(known.value) : (vocab[0] ? String(vocab[0].value) : (cur ?? ""));
          build();
          return;
        }
        this._draft = next;
      });
      box.innerHTML = ""; box.appendChild(f); this._form = f;
    };
    if (rule) { await fetchVocab(rule.entity); }
    build();
    d.querySelector(".ok").addEventListener("click", async () => {
      const dr = this._draft || {}; const secs = parseDuration(dr.timeout);
      const fail = (m) => { err.style.display = ""; err.textContent = m; };
      if (!dr.entity) return fail("Pick an entity.");
      if (!dr.state) return fail("Pick the state to watch.");
      if (secs == null || secs < 60) return fail("Timeout: e.g. 20m, 1h30m (at least 1 minute).");
      if (!rule && this._rules.some((r) => r.entity === dr.entity && String(r.state).toLowerCase() === String(dr.state).toLowerCase())) return fail("That entity and state already have a rule — edit it in the list.");
      d.querySelector(".ok").disabled = true;
      const spec = { entity: dr.entity, state: dr.state, timeoutSecs: secs, actions: Array.isArray(dr.actions) ? dr.actions : [] };
      try {
        if (rule) await this._updateRule(rule, spec); else await this._createRule(spec);
        close();
        await this._run(rule ? `Saved ${h.states[dr.entity]?.attributes?.friendly_name || dr.entity}` : `Created a rule for ${h.states[dr.entity]?.attributes?.friendly_name || dr.entity}`, async () => {}, true);
      } catch (e) { fail(String(e?.message || e)); d.querySelector(".ok").disabled = false; }
    });
    d.showModal();
  }

  async _run(msg, fn, reload) {
    this._busy = true; this._error = null; this._msg = msg; this._render();
    try { await fn(); this._msg = null; }
    catch (e) { this._error = String(e?.message || e); }
    finally { this._busy = false; if (reload) { await new Promise((r) => setTimeout(r, 1500)); this._regAt = 0; await this._loadRules(); } else this._render(); }
  }
}

class SbWatchCardEditor extends HTMLElement {
  setConfig(config) { this._config = { ...config }; this._render(); }
  set hass(hass) { this._hass = hass; if (this._form) this._form.hass = hass; }
  async _render() {
    if (!(await loadHaForm())) return;
    if (!this._form) {
      this._form = document.createElement("ha-form");
      this._form.hass = this._hass;
      this._form.schema = [
        { name: "title", selector: { text: {} } },
        { name: "notify_service", selector: { text: {} } },
        { name: "warn_ahead", selector: { text: {} } },
        { name: "domains", selector: { select: { multiple: true, mode: "list", options: ["switch", "fan", "light", "climate", "humidifier", "cover", "lock", "media_player", "valve", "vacuum", "binary_sensor", "input_boolean"].map((d) => ({ value: d, label: d })) } } },
      ];
      this._form.computeLabel = (s) => ({ title: "Title", notify_service: "Notify service for new rules (notify.mobile_app_…; empty = act with no notice)", warn_ahead: "Notify this long before the actions run (new rules)", domains: "Entity domains offered in the picker (empty = all)" }[s.name]);
      this._form.addEventListener("value-changed", (e) => { e.stopPropagation(); this._config = { ...this._config, ...e.detail.value }; fire(this, "config-changed", { config: this._config }); });
      this.appendChild(this._form);
    }
    this._form.data = this._config;
  }
}

customElements.define(CARD, SbWatchCard);
customElements.define("sb-watch-card-editor", SbWatchCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({ type: CARD, name: "SB Watch Card", description: "Timeout rules: an entity in a state for too long → notify, then run any actions. Edit, pause, delete per rule.", preview: true, documentationURL: "https://github.com/snadboy/sb-watch-card" });
console.info(`%c SB-WATCH-CARD %c v${VERSION} `, "background:#455a64;color:#fff", "background:#90a4ae;color:#000");
