import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import css from "@eslint/css";

// The obsidianmd recommended config includes entries with no `files` filter, so
// their JS rules would also run against .css files and crash (they expect a JS
// AST). Exclude .css from those global entries; the dedicated CSS block below
// lints stylesheets with the CSS language instead.
const obsidianRecommended = obsidianmd.configs.recommended.map((config) =>
  config.files ? config : { ...config, ignores: [...(config.ignores ?? []), "**/*.css"] },
);

export default defineConfig([
  {
    ignores: [
      "main.js",
      "*.mjs",
      "eslint.config.mjs",
      "node_modules/**",
      ".obsidian-cache/**",
      "test-output/**",
      "test/**",
      "scripts/**",
      "wdio*.mts",
    ],
  },
  ...obsidianRecommended,
  {
    // Obsidian's plugin reviewer rejects `!important`; catch it locally instead.
    // Override styles by increasing selector specificity or using CSS variables.
    files: ["**/*.css"],
    language: "css/css",
    plugins: { css },
    rules: {
      "css/no-important": "error",
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: "./tsconfig.json",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint.plugin,
    },
    rules: {
      "@typescript-eslint/no-unsafe-argument": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-return": "warn",
    },
  },
  {
    files: ["debug.ts"],
    rules: {
      "obsidianmd/rule-custom-message": "off",
    },
  },
]);
