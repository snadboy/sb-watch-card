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
