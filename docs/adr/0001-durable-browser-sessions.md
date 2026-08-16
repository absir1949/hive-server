# ADR 0001: Treat a Running Chromium as a Durable Authentication Session

- Status: Accepted
- Date: 2026-08-16

## Context

Hive Server originally stopped a browser after five idle minutes and assumed that its mounted `user-data-dir` would restore the login on the next start. Live verification against a WeChat Shop Profile disproved that assumption: the authentication cookies were non-persistent session cookies. Stopping Chromium left the rows on disk temporarily, but the next Chromium start removed them and the platform returned `biz magic invalid`.

The same destructive lifecycle was reachable through several paths:

1. the generic idle timer;
2. Server restart recovery deleting VNC-mode containers because their in-memory leases were gone;
3. an implicit Headless/VNC mode switch or a CDP connection retry stopping a running container;
4. treating a Docker status-query failure as if the container did not exist;
5. replacing an untracked but still-running container with a new one.

VNC access and the authenticated Chromium process are different resources. Coupling their lifecycles made an ordinary window close or transient connection failure capable of logging an account out.

## Decision

1. A configured Profile is dormant until first use. Keep-alive never starts a stopped Profile.
2. Once started, Chromium remains running until an explicit `POST /browsers/:id/stop`, Profile deletion, or an external process/host failure.
3. Releasing or expiring a VNC lease stops only x11vnc/noVNC and disconnects remote-control clients. It does not stop Chromium.
4. The runtime mode is immutable while Chromium is running. A conflicting explicit mode request returns `409` and requires an explicit stop before switching.
5. A CDP connection failure fails that operation and leaves the running container intact. It is not repaired by an implicit browser restart.
6. After a Hive Server process restart, all running containers are adopted. VNC access is revoked because leases are not recoverable, while Chromium remains running.
7. Scheduled platform keep-alive loads the Profile URL in a minimized background Page and closes that Page after load. It never navigates the foreground page.

## Alternatives Considered

### Keep idle recycling and persist/restore session cookies

Rejected for this change. It creates a separate authentication-backup subsystem, requires platform-by-platform validation, and is not necessary at the current scale. `user-data-dir` alone is not a correct implementation of this alternative.

### Add per-Profile retention policies

Rejected for now. It adds configuration, UI, migration, and mixed semantics before there is a demonstrated need. An explicit stop already provides a clear resource-release operation.

### Run keep-alive more frequently than the idle timeout

Rejected. It merely prevents the timer from firing, does not save memory, and the previous implementation also refreshed the user's foreground page.

## Consequences

- Authenticated sessions no longer disappear because VNC was closed, the Server process restarted, a single CDP request failed, or the browser became idle.
- Started Profiles consume memory continuously and must be capacity-monitored. Unused sessions are released explicitly.
- A host restart, Docker/Chromium crash, or explicit stop can still lose session cookies. Durable session-cookie export/restore is deliberately outside this decision and must not be claimed as implemented.
- Headless/VNC switching is now visible and destructive by design instead of being an implicit side effect.
