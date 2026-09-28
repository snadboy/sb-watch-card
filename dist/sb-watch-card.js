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
const VERSION = "0.1.1";
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
  static getStubConfig() { return { title: "Auto-off", notify_service: "", warn_ahead: "5m", domains: ["switch", "fan", "light", "climate", "humidifier"] }; }

  setConfig(config) {
    this._config = { title: "Auto-off", warn_ahead: "5m", domains: ["switch", "fan", "light", "climate", "humidifier"], ...config };
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
  disconnectedCallback() { clearInterval(this._tick); }

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
      // a timeout rule: exactly one entity id, state on, a time-in-state
      if (pats.length !== 1 || !isEntityId(pats[0]) || !f.state_for) continue;
      if (!Array.isArray(f.states) || f.states.length !== 1 || String(f.states[0]).toLowerCase() !== "on") continue;
      if (f.labels || f.areas || f.device_classes || f.units || f.rate) continue;
      r.entity = pats[0];
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
      r.timeout = r.stateFor + r.warn;
    }));
    rules.sort((a, b) => (this._hass.states[a.entity]?.attributes?.friendly_name || a.entity).localeCompare(this._hass.states[b.entity]?.attributes?.friendly_name || b.entity));
    this._rules = rules;
    this._render();
  }

  // ---- create / edit / delete through SB Watch's flows ------------------------------
  async _createRule(entityId, timeoutSecs) {
    const hass = this._hass, cfg = this._config;
    const name = `${hass.states[entityId]?.attributes?.friendly_name || entityId} timeout`;
    let warn = parseDuration(cfg.warn_ahead) ?? 300;
    warn = Math.min(warn, Math.floor(timeoutSecs / 2));          // never warn before the entity even counts
    const stateFor = timeoutSecs - warn;
    const notify = (cfg.notify_service || "").trim();
    const actions = notify
      ? { action: "notify_then_act", notify_service: notify, act: "turn_off", warn_ahead: toDurText(warn) }
      : { action: "act", act: "turn_off", warn_ahead: "0" };       // no phone configured: act at the timeout
    if (!notify) { /* act mode: the whole timeout is the dwell */ }
    const sf = notify ? stateFor : timeoutSecs;
    let flow;
    try { flow = await hass.callApi("POST", "config/config_entries/flow", { handler: "sb_watch" }); }
    catch (e) { throw new Error("SB Watch is not installed (or you are not an admin)"); }
    const s2 = await hass.callApi("POST", `config/config_entries/flow/${flow.flow_id}`, { name, patterns: entityId, state_for: toDurText(sf), problem: true });
    if (s2.step_id !== "values") throw new Error(s2.errors ? JSON.stringify(s2.errors) : `unexpected step ${s2.step_id}`);
    const done = await hass.callApi("POST", `config/config_entries/flow/${s2.flow_id}`, { states: ["on"], actions });
    if (done.type !== "create_entry") throw new Error(done.errors ? Object.values(done.errors).join(", ") : `unexpected step ${done.step_id}`);
  }

  async _updateTimeout(rule, timeoutSecs) {
    const hass = this._hass, o = rule.options || {};
    const warn = rule.acts && o.action === "notify_then_act" ? Math.min(parseDuration(o.warn_ahead) ?? 300, Math.floor(timeoutSecs / 2)) : 0;
    const step1 = {};
    for (const k of ["name", "patterns", "labels", "areas", "device_classes", "units", "state_for", "rate", "rate_window", "for", "problem", "filter_yaml"]) if (o[k] !== undefined && o[k] !== null) step1[k] = o[k];
    step1.name = step1.name || rule.name; step1.patterns = step1.patterns || rule.entity;
    step1.state_for = toDurText(timeoutSecs - warn);
    const flow = await hass.callApi("POST", "config/config_entries/options/flow", { handler: rule.entryId });
    const s2 = await hass.callApi("POST", `config/config_entries/options/flow/${flow.flow_id}`, step1);
    if (s2.step_id !== "values") throw new Error(s2.errors ? JSON.stringify(s2.errors) : `unexpected step ${s2.step_id}`);
    const actions = { action: o.action || "none", notify_service: o.notify_service || "", act: o.act || "turn_off", warn_ahead: warn ? toDurText(warn) : (o.warn_ahead || "0") };
    const done = await hass.callApi("POST", `config/config_entries/options/flow/${s2.flow_id}`, { states: ["on"], state_min: o.state_min || "", state_max: o.state_max || "", actions });
    if (done.type !== "create_entry") throw new Error(done.errors ? Object.values(done.errors).join(", ") : `unexpected step ${done.step_id}`);
    rule.options = null;                                           // re-read on the next load
  }

  async _deleteRule(rule) {
    await this._hass.callApi("DELETE", `config/config_entries/entry/${rule.entryId}`);
  }

  // ---- render ---------------------------------------------------------------------
  _status(rule) {
    const st = this._hass.states[rule.entity];
    if (!st) return { text: "entity missing", cls: "bad" };
    if (st.state !== "on") return { text: st.state === "off" ? "off" : st.state, cls: "" };
    const on = (Date.now() - new Date(st.last_changed).getTime()) / 1000;
    const paused = this._hass.states[rule.pausedId]?.state === "on";
    if (paused) return { text: `on for ${fmtDur(on)} · paused`, cls: "paused" };
    const left = rule.timeout - on;
    if (left <= 0) return { text: `on for ${fmtDur(on)} · ${rule.acts ? "over the timeout — turning off" : "over the timeout (rule has no action)"}`, cls: "over" };
    if (rule.warn && on >= rule.stateFor) return { text: `on for ${fmtDur(on)} · off in ${fmtDur(left)} (notified)`, cls: "warn" };
    return { text: `on for ${fmtDur(on)} · off in ${fmtDur(left)}`, cls: "on" };
  }

  _render() {
    if (!this._hass || !this._config) return;
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
      .add { display: flex; align-items: flex-end; gap: 10px; margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--divider-color); }
      .add ha-form { flex: 1; }
      .add button { font: inherit; color: var(--text-primary-color, #fff); background: var(--primary-color); border: none; border-radius: 16px; padding: 8px 16px; cursor: pointer; margin-bottom: 6px; }
      .add button[disabled] { opacity: .5; cursor: default; }
      .msg { color: var(--secondary-text-color); font-size: .85em; padding: 6px 0; }
      .msg.err { color: var(--error-color); }
      .empty { color: var(--secondary-text-color); font-style: italic; padding: 10px 0; }
    </style>
    <ha-card>
      <div class="hdr"><div class="title">${esc(cfg.title || "")}</div><div class="n">${this._rules.length} rule${this._rules.length === 1 ? "" : "s"}</div></div>
      ${rows || `<div class="empty">No timeout rules yet — pick an entity below.</div>`}
      <div class="add"><div class="formbox"></div><button class="go" ${this._busy ? "disabled" : ""}>Add</button></div>
      ${this._error ? `<div class="msg err">${esc(this._error)}</div>` : this._msg ? `<div class="msg">${esc(this._msg)}</div>` : ""}
    </ha-card>`;
    // icons
    this.shadowRoot.querySelectorAll(".ic").forEach((ph) => { const st = h.states[ph.dataset.ent]; if (!st) return; const el = document.createElement("ha-state-icon"); el.hass = h; el.stateObj = st; el.className = "ic"; ph.replaceWith(el); });
    // row actions
    this.shadowRoot.querySelectorAll(".row").forEach((row) => {
      const rule = this._rules.find((r) => r.entryId === row.dataset.e); if (!rule) return;
      row.querySelector(".body").addEventListener("click", () => fire(this, "hass-more-info", { entityId: rule.entity }));
      row.querySelector(".pause").addEventListener("click", () => this._hass.callService("switch", h.states[rule.pausedId]?.state === "on" ? "turn_off" : "turn_on", { entity_id: rule.pausedId }));
      row.querySelector(".del").addEventListener("click", () => this._run(`Deleting ${rule.name}…`, async () => { if (!confirm(`Delete the rule for ${h.states[rule.entity]?.attributes?.friendly_name || rule.entity}?`)) return; await this._deleteRule(rule); }, true));
      const to = row.querySelector(".to");
      to.addEventListener("click", () => {
        if (to.querySelector("input")) return;
        to.innerHTML = `<input value="${esc(toDurText(rule.timeout))}" placeholder="20m">`;
        const inp = to.querySelector("input"); inp.focus(); inp.select();
        const commit = () => { const secs = parseDuration(inp.value); if (secs == null || secs < 60) { this._error = "Timeout: e.g. 20m, 1h30m (at least 1 minute)"; this._render(); return; } this._run(`Changing ${rule.name}…`, () => this._updateTimeout(rule, secs), true); };
        inp.addEventListener("keydown", (e) => { if (e.key === "Enter") commit(); if (e.key === "Escape") this._render(); });
        inp.addEventListener("blur", () => { if (this.shadowRoot.contains(inp)) commit(); });
      });
    });
    this._mountForm();
    this.shadowRoot.querySelector(".go").addEventListener("click", () => this._add());
  }

  async _mountForm() {
    const box = this.shadowRoot.querySelector(".formbox"); if (!box) return;
    if (!(await loadHaForm())) { box.innerHTML = `<div class="msg err">HA's form element did not load — open any card editor once and reload.</div>`; return; }
    if (!box.isConnected) return;
    const f = document.createElement("ha-form");
    f.hass = this._hass;
    f.schema = [
      { name: "entity", selector: { entity: { domain: this._config.domains || undefined } } },
      { name: "timeout", selector: { text: {} } },
    ];
    f.computeLabel = (s) => ({ entity: "Entity to watch", timeout: "Turn off after (e.g. 20m, 2h)" }[s.name]);
    f.data = this._draft || { entity: "", timeout: "" };
    f.addEventListener("value-changed", (e) => { e.stopPropagation(); this._draft = e.detail.value; });
    box.innerHTML = ""; box.appendChild(f); this._form = f;
  }

  async _add() {
    const d = this._draft || {};
    const secs = parseDuration(d.timeout);
    if (!d.entity) { this._error = "Pick an entity."; this._render(); return; }
    if (secs == null || secs < 60) { this._error = "Timeout: e.g. 20m, 1h30m (at least 1 minute)."; this._render(); return; }
    if (this._rules.some((r) => r.entity === d.entity)) { this._error = "That entity already has a rule — change its timeout in the list."; this._render(); return; }
    await this._run(`Creating a rule for ${this._hass.states[d.entity]?.attributes?.friendly_name || d.entity}…`, async () => { await this._createRule(d.entity, secs); this._draft = { entity: "", timeout: "" }; }, true);
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
        { name: "domains", selector: { select: { multiple: true, mode: "list", options: ["switch", "fan", "light", "climate", "humidifier", "media_player", "input_boolean"].map((d) => ({ value: d, label: d })) } } },
      ];
      this._form.computeLabel = (s) => ({ title: "Title", notify_service: "Notify service for new rules (notify.mobile_app_…; empty = turn off with no notice)", warn_ahead: "Notify this long before turning off (new rules)", domains: "Entity domains offered in the picker" }[s.name]);
      this._form.addEventListener("value-changed", (e) => { e.stopPropagation(); this._config = { ...this._config, ...e.detail.value }; fire(this, "config-changed", { config: this._config }); });
      this.appendChild(this._form);
    }
    this._form.data = this._config;
  }
}

customElements.define(CARD, SbWatchCard);
customElements.define("sb-watch-card-editor", SbWatchCardEditor);
window.customCards = window.customCards || [];
window.customCards.push({ type: CARD, name: "SB Watch Card", description: "Entity + timeout rules: pick an entity, set how long it may stay on, and SB Watch notifies then turns it off.", preview: true, documentationURL: "https://github.com/snadboy/sb-watch-card" });
console.info(`%c SB-WATCH-CARD %c v${VERSION} `, "background:#455a64;color:#fff", "background:#90a4ae;color:#000");
