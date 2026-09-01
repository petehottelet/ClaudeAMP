#!/bin/sh
# ClaudeAmp one-line macOS installer:
#   curl -fsSL https://claudeamp.com/install | sh
# Downloads the latest release for this Mac's architecture, installs to
# /Applications, clears the quarantine flag (so Gatekeeper's unidentified-
# developer dialog never appears), and launches the app.
set -e

REPO="petehottelet/claudeamp"

case "$(uname -s)" in
  Darwin) ;;
  *) echo "This installer is for macOS. On Windows, grab ClaudeAmp-Setup from:"; \
     echo "  https://github.com/$REPO/releases/latest"; exit 1 ;;
esac

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  *)     ARCH="x64" ;;
esac

echo "Finding the latest ClaudeAmp release ($ARCH)..."
RELEASE_JSON=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest")
URL=$(printf '%s' "$RELEASE_JSON" \
  | grep -o "https://[^\"]*ClaudeAmp-[0-9.]*-$ARCH\.zip" | head -1)
SUMS_URL=$(printf '%s' "$RELEASE_JSON" \
  | grep -o "https://[^\"]*SHA256SUMS\.txt" | head -1)

if [ -z "$URL" ]; then
  echo "Could not find a $ARCH build in the latest release." >&2
  echo "Check https://github.com/$REPO/releases" >&2
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "Downloading $URL"
curl -fL --progress-bar "$URL" -o "$TMP/ClaudeAmp.zip"

# Verify against the release's checksum manifest. Releases before v1.6 have
# no SHA256SUMS.txt - warn and continue there; a mismatch is always fatal.
if [ -n "$SUMS_URL" ]; then
  curl -fsSL "$SUMS_URL" -o "$TMP/SHA256SUMS.txt"
  FILE=$(basename "$URL")
  EXPECTED=$(awk -v f="$FILE" '$2 == f { print $1 }' "$TMP/SHA256SUMS.txt")
  ACTUAL=$(shasum -a 256 "$TMP/ClaudeAmp.zip" | awk '{ print $1 }')
  if [ -z "$EXPECTED" ]; then
    echo "Warning: $FILE is not listed in SHA256SUMS.txt; continuing without verification." >&2
  elif [ "$EXPECTED" != "$ACTUAL" ]; then
    echo "Checksum mismatch for $FILE" >&2
    echo "  expected: $EXPECTED" >&2
    echo "  actual:   $ACTUAL" >&2
    echo "Refusing to install. Re-run later or download manually from" >&2
    echo "  https://github.com/$REPO/releases" >&2
    exit 1
  else
    echo "Checksum verified."
  fi
else
  echo "Warning: this release has no SHA256SUMS.txt yet; skipping verification." >&2
fi

echo "Installing to /Applications..."
ditto -xk "$TMP/ClaudeAmp.zip" "$TMP/unpacked"
rm -rf /Applications/ClaudeAmp.app
ditto "$TMP/unpacked/ClaudeAmp.app" /Applications/ClaudeAmp.app

# strip the quarantine flag so the unidentified-developer dialog never shows
xattr -cr /Applications/ClaudeAmp.app || true

echo "ClaudeAmp installed. Launching..."
open /Applications/ClaudeAmp.app
