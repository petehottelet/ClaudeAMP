# ClaudeAmp agent guide

This is the canonical repository for the ClaudeAmp desktop application:
`https://github.com/petehottelet/claudeamp`. The marketing site at
`https://www.claudeamp.com` is deployed separately on Vercel. Do not replace
landing-page work or Vercel routing unless the user explicitly puts it in scope.

Read `CLAUDE.md` for the repository metadata, icon specifications, and the
owner's attribution requirements. Those instructions apply to every coding
agent despite the filename.

## Working safely

- Start from the current remote `main`; never resurrect an old checkout or
  version. `package.json` is the authority for the current version.
- Do not create a branch unless the user asks for one. Release branches are
  one-shot workflow triggers and must be deleted after publication.
- Respect `.gitignore` and `.vercelignore`. Never commit `node_modules/`,
  `dist/`, `.env*`, temporary reports, or agent handoff directories.
- Preserve unrelated user work. Fetch immediately before committing and push
  only a fast-forward update.
- Commit as `petehottelet` using
  `36128338+petehottelet@users.noreply.github.com`; never add agent attribution
  or co-author trailers.

## Verification

```powershell
npm ci
npm run verify:source
npm run verify
```

`npm run verify` launches the real Electron app and proves the window shape,
bridge, media preview, PTY shell, reload restoration, and terminal input. Run it
for application or release-pipeline changes. Documentation-only changes need at
least `npm run verify:source` when they touch executable examples or workflows.

## Releases

Keep `package.json`, `package-lock.json`, `js/version.js`, the version badge,
the version regression test, and `CHANGELOG.md` synchronized. Future releases
derive their GitHub notes from the matching changelog section through
`scripts/release-notes.cjs`. Follow `docs/RELEASING.md`; never overwrite an
existing release's artifacts.
