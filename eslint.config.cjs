"use strict";

/* Flat ESLint config tuned to this codebase's idioms: classic scripts with
   revealing-module globals in js/, CommonJS everywhere else, and deliberate
   best-effort `catch (_) {}` blocks. no-undef is the rule that pays rent
   here - 167 string element ids and a no-bundler renderer make typos
   otherwise silent. */

const js = require("@eslint/js");
const globals = require("globals");

const tuned = {
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: "^_" }],
  // Terminal code legitimately matches ESC bytes.
  "no-control-regex": "off",
  // Rethrows with rewritten user-facing messages are deliberate here.
  "preserve-caught-error": "off",
};

// The revealing-module files each define one global the other scripts read;
// within the defining file the const itself is "unused".
const MODULE_GLOBALS = "^_|^(ClaudeAPI|WM|Music|MediaLibrary|MusicService|PixelFont|GLYPHS)$";

module.exports = [
  { ignores: ["node_modules/**", "dist/**", "docs/**", "assets/**"] },
  {
    files: ["bridge.js", "electron/**/*.cjs", "scripts/**/*.{js,cjs}", "test/**/*.cjs", "eslint.config.cjs"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "commonjs",
      globals: globals.node,
    },
    rules: { ...js.configs.recommended.rules, ...tuned },
  },
  {
    files: ["js/**/*.js"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "script",
      globals: {
        ...globals.browser,
        // Cross-file module globals, each defined by the script that owns it
        // (script tags in index.html load them in dependency order).
        ClaudeAPI: "readonly",
        WM: "readonly",
        Music: "readonly",
        MediaLibrary: "readonly",
        MusicService: "readonly",
        PixelFont: "readonly",
        GLYPHS: "readonly",
        RADIO_STATIONS: "readonly",
        Terminal: "readonly",
        FitAddon: "readonly",
        YT: "readonly", // YouTube IFrame API
      },
    },
    rules: {
      ...js.configs.recommended.rules,
      ...tuned,
      "no-unused-vars": ["error", { args: "none", caughtErrors: "none", varsIgnorePattern: MODULE_GLOBALS }],
      // The defining file's own `const WM = ...` redeclares its configured
      // global by design.
      "no-redeclare": "off",
    },
  },
];
