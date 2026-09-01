# Security

## Reporting

Please report suspected vulnerabilities privately via GitHub Security
Advisories ("Report a vulnerability" on the repository's Security tab)
rather than public issues.

## Threat model, briefly

- The bridge (`bridge.js`) binds `127.0.0.1` only, rejects foreign `Host`
  headers (DNS-rebinding) and cross-origin browser requests, and gates
  every non-static route on a per-run random bearer token compared in
  constant time. In the desktop app the token travels to the renderer over
  IPC only; `/bridge/status` discloses neither the token nor `PATH`.
- CLI access is least-privilege and enforced server-side: the desktop shell
  owns the access ceiling (read-only by default; workspace edits and shell
  commands are separate opt-ins) and the bridge clamps every request to it —
  see `clampAccess` in `bridge.js` and `test/bridge-security.test.cjs` /
  `test/bridge-integration.test.cjs`, which pin the exact CLI flags.
- API keys are encrypted at rest via the OS keychain (Electron
  `safeStorage`) in the desktop app; connected-service OAuth tokens live in
  `~/.claudeamp/` with owner-only permissions. Browser dev mode falls back
  to `localStorage` and keeps the token bootstrap in `/bridge/status` — it
  is a development convenience, not a hardened surface.
- The renderer runs with `contextIsolation`, `sandbox`, a deny-all
  permission handler, a Content-Security-Policy restricted to the hosts the
  app uses, and IPC handlers that verify the sender.

Standalone `node bridge.js` trusts the local machine more than the packaged
app does; treat it as a development mode.
