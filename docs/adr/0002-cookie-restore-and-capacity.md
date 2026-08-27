# ADR 0002: Cookie Dump/Restore and Running Capacity

- Status: Accepted
- Date: 2026-08-27
- Supersedes: the “process must stay alive” capacity consequence of ADR 0001

## Context

ADR 0001 stopped implicit Chromium restarts because WeChat Shop auth uses session cookies (`biz_magic` and related). That protected logins, then left ~28 headed Chrome containers running on a 4-core N100.

Live verification on 2026-08-27 against 原野小店 (profile 29) showed:

1. Deleting `biz_*` cookies produces `登录超时，请重新登录`.
2. CDP `Network.setCookies` of a prior dump restores the dashboard.
3. Headless can hold a live login. The original outages were process kills, not Headless itself.

`user-data-dir` is still not a backup. Cookie dump/restore is.

## Decision

1. Persist cookies to `data/{profileId}/auth-cookies.json` before stop, mode switch, eviction, and after successful keep-alive.
2. On cold start, inject cookies then reload the Profile URL. WeChat Shop Headless starts fail with `401 needsLogin` if the probe still shows a login prompt. VNC starts still succeed so a human can scan.
3. Default runtime is Headless. VNC remains an explicit, destructive switch, wrapped in dump/restore.
4. Cap concurrent browsers (`MAX_RUNNING_BROWSERS`, default 8). LRU eviction skips VNC leases and open collection pages.
5. Idle-stop unused browsers after `IDLE_STOP_MS` (default 10 minutes) when no VNC lease is held. Dump first.
6. Keep-alive still never starts a stopped Profile. It only refreshes a running one and dumps cookies.
7. Each Chrome container gets a memory and CPU limit so one renderer cannot take the host.

## Consequences

- Logins can survive a planned stop. They can still fail if WeChat invalidates the ticket; that is reported instead of collected against a logged-out page.
- Hive Server restart trims recovered containers down to the cap.
- N100 can run a handful of Headless sessions instead of dozens of Xvfb desktops.
