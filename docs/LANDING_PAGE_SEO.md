# ClaudeAmp landing-page SEO acceptance checklist

This is the handoff contract for the separately deployed `claudeamp.com`
landing page. It intentionally does not prescribe the visual design.

## Indexing and canonical URLs

- `https://www.claudeamp.com/` returns `200` with indexable HTML.
- `http://` and `https://claudeamp.com/` permanently redirect (`308`) to the
  matching `https://www.claudeamp.com/` URL.
- Every indexable page declares a self-referencing canonical URL.
- `/robots.txt` allows the public site and names `/sitemap.xml`.
- `/sitemap.xml` contains only canonical, public URLs with accurate modification dates.
- `/download` links or redirects to the latest GitHub release; `/install`
  continues serving the checksum-verifying macOS installer script.

## Search presentation

- Use one descriptive `<h1>` that includes `ClaudeAmp` and its category.
- Suggested title: `ClaudeAmp – Desktop AI Terminal for Claude Code & Codex`.
- Suggested description: `A classically styled desktop terminal for Claude Code, OpenAI Codex, and Ollama, with real PTY workflows for Windows, macOS, and Linux.`
- Add unique Open Graph and X/Twitter title, description, URL, and a solid-background
  1200×630 or 1280×640 branded image.
- Add `SoftwareApplication` JSON-LD with `name`, `applicationCategory`,
  `operatingSystem`, current `softwareVersion`, canonical `downloadUrl`,
  `releaseNotes`, and a free `Offer` (`price: 0`, `priceCurrency: USD`).
- Include favicon sizes, an Apple touch icon, and a web-app manifest using the
  approved claw artwork.

## Content and trust

- Put a clear download action in the first viewport and offer explicit Windows,
  macOS Apple Silicon, macOS Intel, and Linux choices.
- Link to the latest release notes, checksums, source repository, license,
  security policy, and installation instructions.
- Describe Claude Code, OpenAI Codex, and Ollama naturally in visible copy; do
  not use hidden keyword blocks or repeat phrases unnaturally.
- State that the project is independent and not affiliated with Anthropic,
  OpenAI, Winamp, or the other services it integrates.
- Use the real application screenshot with descriptive alt text and explicit
  dimensions to prevent layout shift.

## Accessibility and performance

- Preserve semantic landmarks and heading order, visible keyboard focus, labeled
  controls, and AA text contrast.
- Respect `prefers-reduced-motion`; the experience must remain complete without
  animation.
- Target Core Web Vitals at the 75th percentile: LCP ≤ 2.5 s, INP ≤ 200 ms,
  and CLS ≤ 0.1.
- Serve responsive AVIF/WebP images with PNG fallbacks and cache immutable assets.
- Avoid loading the Electron application's runtime, music catalog, or YouTube
  player on the marketing page.

## Measurement and launch verification

- Enable privacy-conscious Web Analytics and Vercel Speed Insights.
- Register both the domain and sitemap in Google Search Console and Bing Webmaster Tools.
- Validate JSON-LD with Google's Rich Results Test and inspect social cards before launch.
- Test the production deployment at 360, 768, 1440, and 1920 CSS pixels, with
  keyboard-only navigation and reduced motion.
- Recheck `/`, `/download`, `/install`, `robots.txt`, and `sitemap.xml` after
  every routing or domain change.
