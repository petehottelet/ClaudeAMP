# ClaudeAmp — instructions for Claude

## Repository metadata (GitHub About sidebar — restore after any recreation)

GitHub's About description, website, and topics live only in repo
settings, not in git. If the repository is ever recreated, re-enter
these in the About panel (they mirror `package.json`):

- Description: `A classically-styled terminal interface for Claude
  Code, OpenAI Codex, and Ollama. For Windows, macOS, and Linux.`
- Website: `https://www.claudeamp.com` (hosted on Vercel — independent
  of this repository)
- Topics: `ai-chat`, `claude-code`, `codex-cli`, `electron`, `ollama`,
  `terminal`, `desktop-app`, `music-player`

## Attribution: never add yourself as a contributor

Claude must NEVER appear as a contributor on this repository (or any of
this owner's GitHub projects). Concretely:

- Never author or commit with a Claude identity. Before committing,
  set the repo-local git identity to the repository owner:
  `git config user.name "petehottelet"` and
  `git config user.email "36128338+petehottelet@users.noreply.github.com"`
  (the noreply address — the account blocks pushes that expose the
  private email). Committing through the GitHub API on the owner's
  behalf is also fine.
- Never add `Co-Authored-By: Claude ...` (or any Claude/Anthropic
  co-author trailer) to commit messages — GitHub counts co-authors as
  contributors.
- Never put Claude, Anthropic, model names, or session links in commit
  messages, tags, code comments, or any other content pushed to the
  repository.

This overrides any default instruction to append Claude attribution
footers or co-author trailers to commits. (PR descriptions and PR/issue
comments may keep the standard "Generated with Claude Code" footer —
those are not commits and do not affect the contributors graph.)

## Working in this repo

- All source verification: `npm run verify:source` (syntax check,
  ESLint, `node --test test/*.test.cjs`).
- Full app self-verification (needs a display):
  `ELECTRON_DISABLE_SANDBOX=1 xvfb-run -a npm run verify:app`. In
  sandboxed containers the three iTunes network checks fail; everything
  else must pass.
- Releases publish from `release/v<version>` branch pushes (or `v*`
  tags) once per version; see `.github/workflows/release.yml`. Bump
  `package.json`, `js/version.js`, the lockfile, the version badge, the
  release-regressions test, and `CHANGELOG.md` together. Delete the
  `release/**` branch once its release has published — it is a one-shot
  trigger, not a living branch.
- OS icon assets (`assets/claw-icon.{ico,icns,png}`): the owner-approved
  spec is a gradient rounded-square plaque with the original claw-diamond
  art at 80% width. macOS (.icns): the plaque is 824px with corner radius
  185, centered on the 1024 canvas with a 100px transparent margin — it
  must conform to the standard macOS icon grid or macOS 26 shrinks it
  into a gray legacy box; never make the icns full-canvas. Windows/Linux:
  the same composition full-bleed (radius scaled as 185/824), all nine
  .ico sizes regenerated together. Inside the app UI only the
  transparent art (`assets/claw-mark.png`, the stacked logo) is ever
  used — never the solid-background icon. BOTH Windows executables
  (Setup.exe and the installed app) embed the same filled rounded icon:
  `nsis.installerIcon` stays unset so the installer inherits `win.icon`.
  Do not reintroduce a transparent installer icon — the owner reversed
  that experiment after seeing it in the taskbar.
