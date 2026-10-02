# SB Watch Card — session notes

Repo `snadboy/sb-watch-card`, local `~/projects/git/sb-watch-card`, MIT, HACS
plugin (`dist/sb-watch-card.js`). Born 2026-09-28: the user wanted "add the
heater switch with a 20-minute timeout, the TSR fan with 2 hours" on a
dashboard, like SB Scheduler's card — after rejecting a label-wide auto-off.

## What it is

A shadow-DOM card, no editor shell (plain ha-form editor). Discovers rules via
`config/entity_registry/list` (platform `sb_watch`, grouped by
`config_entry_id` → count/active/paused entities) and keeps only "timeout
rules": `filter.patterns == [one entity id]`, `states == [on]`, `state_for`
set, nothing else. Warn-ahead comes from the rule's options via
`/api/diagnostics/config_entry/<id>` (admin), cached per rule; `timeout =
state_for + warn_ahead` for notify_then_act rules. Countdown from the
entity's `last_changed` (30 s tick). Add = SB Watch config flow (step 1
`{name, patterns: id, state_for, problem}`, step 2 `{states:[on],
actions}`); notify_then_act when the card has a `notify_service`, else
plain act; `warn ≤ timeout/2`. Change timeout = options flow with the
existing options re-sent. Delete = DELETE config entry (with confirm()).
Paused = the rule's switch. `loadHaForm()` = the entities-card
getConfigElement trick to force ha-form in.

## 0.1.1 (2026-09-28)

`toDurText` rounded sub-minute values to "1m" (a 1-minute timeout gave a
30 s warn → "1m" → state_for 1m + warn 1m); seconds are now emitted as
`30s`. Over-timeout text says what the rule will do. The real "Turn off
failed" was SB Watch's baseline (fixed in sb_watch 0.5.2).

## 0.2.0 (2026-09-28)

User: the add form should be a modal from an Add button; actions Turn
on / Turn off / Toggle / Run script. Header "＋ Add" → `dialog.adddlg` in
the shadow root (showModal), ha-form with entity, timeout, act select and
a script picker that appears when act = run_script (form rebuilt on act
change); validation inline; on create → `_createRule(entity, secs, act,
script)` (adds `act_script` to the actions). Rows show an action glyph
with "At the timeout: …" and the countdown verb follows the act. Timeout
edit re-sends `act_script`. Verified headless with a toggle rule on a
throwaway input_boolean firing at 1 min, logbook entry present.

## 0.2.1 — the dialog survives updates (2026-09-28)

User: "the dialog sometimes jumps or is dismissed when the cards behind it
update". Cause: the dialog lived in the shadow root and `_render()`
replaces `shadowRoot.innerHTML` on every hass-driven update (state
changes, 30 s tick). Fix: (1) the dialog is appended to `document.body`
with its own `<style>` (`DIALOG_STYLE`, class `sbw-adddlg`) — same
pattern as sb-entity-browser's toggle-all dialog; (2) `_render()` defers
while `this._dlg` or `this._editing` (inline timeout input) is set
(`_dirty`), and the close/commit paths re-render if dirty.
disconnectedCallback closes a dangling dialog.

## 0.3.0 — entity → state → timeout → actions; Edit per row (2026-09-28)

User's four asks: Edit button; entity first then the state to watch; other
domains (cover…); actions like SB Scheduler. One `_openDialog(rule|null)`
serves Add and Edit: entity picker (domains empty = all) → on pick,
`sb_filter/values` for that entity gives the state options (label +
raw; default = current state if known) and a default action per domain
(homeassistant.turn_off / cover.close_cover / lock.lock) → timeout → an
HA **ActionSelector** (`selector: {action: {}}`) = the automation action
editor. `_actionsFor(spec)`: actions → `act: run_actions` + `act_actions`
(sb_watch 0.7.0), empty = notify-only/track; notify_then_act when the
card has a notify service. Discovery accepts any single state value;
rows read "Closed for 12 min · close cover in 8 min" via `_stateLabel`
from a per-entity vocabulary cache. Older quick-act rules are shown and,
on edit, converted to run_actions. Verified headless.

## 0.3.1 (2026-09-28) — dialog back in the shadow root

0.3.0's dialog on `document.body` broke HA's action editor: `ha-target-*`
reads registries/states from Lit contexts provided by the app element, and
document.body is outside that tree → `_checkTargetExists` on undefined
`_states`. The dialog now lives in the card's shadow root (inside HA's
tree); the `_render()` guard from 0.2.1 keeps updates from tearing it
down. Verified: target chip "Garage Door" renders, 5 updates with the
dialog open, no page errors.

## 0.4.0 — Notify checkbox, honest timing notice, tap target (2026-09-28)

User (screenshot: "1m" timeout with "notified 5m before" — at odds):
the helper echoed the card default while `_actionsFor` caps warn at
timeout/2. Now a live notice line under the form computes the real
split ("Notified after 30 s, actions run 30 s later at 1 min"). Per-rule
"Notify the phone first" boolean (shown when the card has a notify
service; default on; edit prefills from the rule's action mode) →
`spec.notify` → act vs notify_then_act. Card option `notify_url` →
rule option → SB Watch 0.7.1 sends `clickAction`/`url` (default
`entityId:<active>` = the entity's more-info).

## 0.5.0 — in-effect window and days (2026-09-29)

Two checkboxes in the dialog: "Only during a time window" → From/Until
(HA time selectors, may cross midnight) and "Only on these days" → weekday
multi-select; ANDed; passed as the flow's `effect` section (sb_watch
0.8.0). Rows show a blue clock glyph with the gate and "not in effect
now (18:00–06:00, Mon Tue)" while the Count sensor's `in_effect` is
false. Same-start-and-end is rejected. Verified headless.

## 0.5.1 — rule options re-read on every refresh (2026-09-30)

User screenshot: Garage Door row said "not in effect now (always)" and the
edit dialog showed the window toggle OFF, while the entry's options held
window 19:00–05:00. `_loadRules` fetched each rule's options (diagnostics)
ONCE and reused them for the card's lifetime (only its own `_updateRule`
nulled them), so a window set through HA's options flow — or by the same
card in another tab — never reached it; the status came from the Count
sensor's live `in_effect` and disagreed. Now every `_loadRules` (≤ 1/min,
and after edits) re-reads the options; the old value is kept only when the
read fails. Verified: an external options-flow edit (05:00 → 05:30) shows
after the next refresh; restored.

## 0.6.0 — the full rule editor; `rules: all` (2026-10-01)

For sb_watch 0.9.0's selection + triggers model. `timeoutOf(attrs)` now reads
the Count sensor's `selection` / `triggers` / `advanced` (falls back to the old
`filter.state_for` shape). The quick dialog posts `patterns: [entity]`,
`advanced: {problem}` and `triggers: [{kind: state, value, for}]`.
`rules: all` lists every rule (`kind: general` rows) and opens `_openEditor`:
the user's sketch, with stacked category rows instead of tabs and ONE trigger
list instead of three tabs (both agreed in review), and — the user's one
change — each category's add controls on their own line under the chips.
Live counts via `sb_filter/match`; state suggestions via `sb_filter/values`.
`_saveRuleFull` hands a rule's action block back untouched unless the Actions
section was changed (`actionsTouched`), and omits `triggers` when YAML is set
so the integration's absorbed rows survive.
TEST GOTCHA (again): a card appended to document.body is outside HA's app
tree — the action editor and time inputs throw (`_states`, `time_format`).
Test the dialog on a card that lives in a dashboard.

## 0.6.1 — posts the whole rule in one step (2026-10-01)

sb_watch 0.10.0 made its form one page. `_submit(root, flowId, body)` posts
`{name, selection, trigger, actions, effect, advanced}`; a refusal comes back
as the same form with errors → `_flowError`, and the flow is DELETEd so none
is left in progress (verified: 0 after a refused save).
TEST NOTE: a new rule in the editor defaults "Notify first" ON when the card
has a notify service — an "above_horizon, at once" test rule pushed one real
notification to the phone. Untick notify in editor tests.

## 0.6.2 — usable outside a dashboard; default notify service (2026-10-01)

sb_watch 0.11.0 ships this file inside its sidebar panel (built by
`sb-watch/tools/build_panel.py` under other element names — **this repo is the
editor's one home; after changing it, rebuild and release sb-watch too**).
`loadHaForm` now works with no dashboard loaded (loads Lovelace via
`partial-panel-resolver`, waits for `hui-entities-card` to be defined).
`_commonNotify()` = the notify service most rules use: the default for a new
rule's "Notify first" when the card (or the panel) names none. `_loaded` flag
for the panel's deep links.

## 0.7.0 — state questions go to SB Watch (2026-10-02)

SB Filter grammar 5 answers selection only. The editor's live counts are one
`sb_watch/preview {selection, triggers}` call (selected + "match now"), state
suggestions and the timeout rows' state labels come from `sb_watch/values
{selection}`. Needs sb_watch ≥ 0.12.0. Rebuilt into the panel (sb_watch 0.12.0).

## 0.8.0 — Which entities = a filter OR entities (2026-10-02)

Editor: radio *A filter* / *These entities*; filter dropdown from `sb_filter/filters`
with **New filter…** / **Edit filter…** → `openFilterDialog` (imports SB Filter's
`dialog_url`, opens it in the card's shadow root — on top of the modal editor);
entities = ha-form entity selector (multiple). Chips/pickers for patterns, areas,
labels, classes REMOVED (selections are made in SB Filter). Quick timeout rules post
`selection: {filter: "", entities: [entity]}`; `timeoutOf` reads `source.entities`
(falls back to 0.9–0.12's single-pattern shape). Verified in the panel: Batteries
low shows "Batteries (66)", 66 selected · 14 match now; a new entities rule saved
`entities: [...]` (throwaway helper, deleted).
