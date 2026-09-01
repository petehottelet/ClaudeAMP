# Releasing ClaudeAmp

Release work must start from the current remote `main`. The regression tests deliberately assert the features that were lost when an installer was once built from an obsolete checkout.

GitHub Actions runs the full Electron, window-shape, bridge, playback, and PTY
proof on both Windows and macOS before any installer builds. The postinstall
patch restores node-pty's executable bits on macOS so the hosted ARM runner can
exercise a real shell rather than relying on source-only checks.

## Required checks

```powershell
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
npm ci
npm run verify
npm run dist:win
npm run smoke:packaged
```

The ancestry command must exit successfully. Before publishing, confirm that `package.json`, `package-lock.json`, and `js/version.js` all contain the same new version.

The Windows installer is written to `dist/ClaudeAmp-Setup-<version>.exe`. Do not reuse a previously released version number or overwrite an older installer with different bytes.

ClaudeAmp packages node-pty's official prebuilt native module (`npmRebuild` is disabled). The full app and packaged-app checks both open the terminal and require real shell output, so a missing or incompatible prebuild fails verification directly without requiring a Visual Studio toolchain on the release machine.

## Windows distribution checks

```powershell
$installer = Get-ChildItem 'dist/ClaudeAmp-Setup-*.exe' |
  Sort-Object LastWriteTime |
  Select-Object -Last 1
Get-FileHash -Algorithm SHA256 -LiteralPath $installer.FullName
Get-AuthenticodeSignature -LiteralPath $installer.FullName |
  Format-List Status, StatusMessage, SignerCertificate, TimeStamperCertificate
```

Public Windows installers should be Authenticode-signed. Electron Builder uses `CSC_LINK` and `CSC_KEY_PASSWORD` when signing credentials are configured; an unsigned local build is suitable for testing but should be labeled clearly.

## Release checklist

- Current remote `main` is an ancestor of the release commit.
- Source syntax and regression tests pass.
- The real Electron app verification passes on Windows, including terminal output.
- macOS source verification passes; test the macOS build on a normal Mac before a public launch.
- The packaged Electron verification passes.
- The installer has a unique version and filename.
- SHA-256 and Authenticode status are recorded.
- Installer, block map, and `latest.yml` are archived together.
- The generated release notes match the version's `CHANGELOG.md` entry.
- Delete the one-shot `release/v<version>` branch after the release and checksum
  verification complete; the tag and release retain the permanent history.
