"use strict";

/* Pure helpers for the passive update check: parse a release tag and decide
   whether it is newer than the running version. Kept out of main.cjs so the
   comparison is unit-testable (test/version-check.test.cjs). */

function parseVersion(value) {
  const match = String(value || "").match(/(\d+)\.(\d+)\.(\d+)/);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewerVersion(candidate, current) {
  const a = parseVersion(candidate);
  const b = parseVersion(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return false;
}

module.exports = { parseVersion, isNewerVersion };
