# Contributing to ClaudeAmp

## Getting started

```bash
npm install        # pulls Electron (dev dependency) and builds node-pty
npm start          # the frameless desktop shell over your real desktop
node bridge.js     # or: browser dev mode at http://localhost:8014/
```

No bundler, no framework: `js/` is classic scripts loaded in dependency
order by `index.html`, `electron/` is the desktop shell, `bridge.js` is the
loopback server embedded by the app (and standalone in browser dev mode).

## Before you push

```bash
npm run verify:source   # syntax check + ESLint + the full unit suite
npm run verify          # the above plus a real app launch with ~40 runtime proofs
```

`verify:source` is what pull-request CI runs; the two-OS app-launch matrix
runs on pushes to `main` and inside the release pipeline. A PR is expected
to keep both green. New behavior wants a test: prefer the vm-context and
integration patterns in `test/` over source-grepping.

## Conventions

- Match the house style you see: two-space indent, double quotes, small
  named helpers, revealing-module IIFEs in `js/` with one narrow global.
- Comments explain *why* — the constraint or failure a line prevents — not
  what the next line does.
- `catch (_) {}` is reserved for genuinely best-effort operations; anything
  a user or developer would need to know about must surface.

## Releasing

Bump the version in `package.json`, `package-lock.json`, `js/version.js`,
`assets/badges/version.svg`, and the README badge; move the `[Unreleased]`
notes in `CHANGELOG.md` under the new version; then push a `v*` tag (or a
`release/vX.Y.Z` branch — it publishes only if that version has no release
yet). CI verifies on real macOS and Windows, builds all installers, creates
the release once via the `prepare` job, attaches `SHA256SUMS.txt`, and
fails unless every artifact is present and checksums round-trip.
