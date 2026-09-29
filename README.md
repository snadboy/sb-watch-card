# SB Watch Card

Timeout rules on a dashboard: **an entity, in a state, for too long → notify, then run
any actions.** Built on [SB Watch](https://github.com/snadboy/sb-watch).

Each row is one SB Watch rule watching one entity for one state: a live *state for /
action in* countdown, **Edit** (entity, state, timeout, actions), **Pause** (keep
tracking, take no action) and delete. **Add** opens a dialog: pick the entity first,
then the state to watch — offered from that entity's own vocabulary (Open/Closed for a
cover, Locked/Unlocked for a lock, On/Off for a light) — then the timeout, whether to notify the phone first (per rule), the
actions, and optionally **when the rule is in effect**: a daily time window (may
cross midnight, 18:00 → 06:00) and/or a set of weekdays, ANDed — outside them the
rule sees nothing, in Home Assistant's own action editor, exactly like an automation or an SB
Scheduler step. Any domain works.

```yaml
type: custom:sb-watch-card
title: Timeouts
notify_service: notify.mobile_app_pixel   # empty = run the actions at the timeout with no notice
warn_ahead: 5m                            # notify this long before the actions run (capped at half the timeout)
notify_url: /dashboard-monitor/0          # where a tap on the push goes; empty = the entity's more-info
domains: []                               # what the picker offers; empty = every entity
```

The card stores nothing: creating, editing and deleting go through SB Watch's config and
options flows (admin login required). A rule made here has the usual device page with
Active, Count and Paused entities, and every action it runs is written to the Logbook.
