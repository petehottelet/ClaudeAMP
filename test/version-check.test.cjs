"use strict";

const test = require("node:test");
const assert = require("node:assert");
const { isNewerVersion, parseVersion } = require("../electron/version-check.cjs");

test("release tags parse with or without the v prefix", () => {
  assert.deepEqual(parseVersion("v1.6.1"), [1, 6, 1]);
  assert.deepEqual(parseVersion("1.10.0"), [1, 10, 0]);
  assert.equal(parseVersion("nightly"), null);
});

test("newer-version comparison is numeric, not lexicographic", () => {
  assert.equal(isNewerVersion("v1.7.0", "1.6.1"), true);
  assert.equal(isNewerVersion("v1.6.1", "1.6.1"), false);
  assert.equal(isNewerVersion("v1.6.0", "1.6.1"), false);
  assert.equal(isNewerVersion("v1.10.0", "1.9.9"), true);
  assert.equal(isNewerVersion("v2.0.0", "1.99.99"), true);
  assert.equal(isNewerVersion("garbage", "1.6.1"), false);
  assert.equal(isNewerVersion("v1.7.0", "garbage"), false);
});
