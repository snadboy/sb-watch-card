# SB Watch Card

Entity + timeout rules on a dashboard. Pick an entity, say how long it may stay on,
and [SB Watch](https://github.com/snadboy/sb-watch) notifies you shortly before the
timeout and turns it off at the timeout.

The card lists the SB Watch rules that watch **one entity being `on` for a while**
(made here or in Settings), each with a live *on for / off in* countdown, a
**Paused** toggle (keep tracking, take no action) and delete. Click the timeout to
change it. Everything goes through SB Watch's own config and options flows — the
card stores nothing, and an admin login is required.

```yaml
type: custom:sb-watch-card
title: Auto-off
notify_service: notify.mobile_app_pixel   # empty = turn off at the timeout with no notice
warn_ahead: 5m                            # notify this long before turning off
domains: [switch, fan, light, climate]    # what the picker offers
```

Requires SB Watch (and therefore SB Filter). A rule made here is an ordinary SB Watch
rule: its device page has the Active, Count and Paused entities like any other.
