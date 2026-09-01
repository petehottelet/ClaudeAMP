---
name: "macOS: clicks fall through / feel eaten"
about: A panel click reached the app behind, or a desktop click near a panel hit ClaudeAmp
labels: bug, macos
---

**Which case?**
- [ ] A click on a panel (title bar / button / edge) went to the app behind
- [ ] A click on the desktop near a panel was captured by ClaudeAmp
- [ ] A drag dropped when the cursor slipped off the panel

**Exact repro**
1. Which app was frontmost before the click:
2. Where you clicked (panel name and roughly where on it):
3. How fast the cursor entered (slow move / fast flick / trackpad tap):

**Setup**
- macOS version and Mac model:
- ClaudeAmp version and zoom level (1x / 1.5x / 2x / 3x):
- Displays (built-in only / external, and which is primary):

If you can, attach the report from `npm run verify:app` on your machine —
the `macEnterMargin`/`macHit` checks localize this class of bug. Tuning
knobs live in `electron/mac-hittest.cjs` (`ENTER_MARGIN`, `NEAR_MS`).
