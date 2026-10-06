import js from "@eslint/js"
import pluginNext from "@next/eslint-plugin-next"
import eslintConfigPrettier from "eslint-config-prettier"
import pluginReact from "eslint-plugin-react"
import pluginReactHooks from "eslint-plugin-react-hooks"
import unusedImports from "eslint-plugin-unused-imports"
import globals from "globals"
import tseslint from "typescript-eslint"

export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["fixture/**/*.{ts,tsx}"],
    ...pluginReact.configs.flat.recommended,
  },
  {
    files: ["fixture/**/*.{ts,tsx}"],
    plugins: {
      "@next/next": pluginNext,
    },
    settings: {
      next: { rootDir: "fixture" },
      react: { version: "detect" },
    },
    rules: {
      ...pluginNext.configs.recommended.rules,
      ...pluginNext.configs["core-web-vitals"].rules,
      // The new JSX transform makes React scope unnecessary.
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
    },
  },
  {
    // The package's own hooks follow the same rules as the fixture's.
    files: ["src/**/*.{ts,tsx}", "fixture/**/*.{ts,tsx}"],
    plugins: {
      "react-hooks": pluginReactHooks,
    },
    rules: {
      ...pluginReactHooks.configs.recommended.rules,
      // A missing dependency is a stale-closure bug, not a style nit.
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    plugins: {
      "unused-imports": unusedImports,
    },
    rules: {
      "@typescript-eslint/no-unused-vars": "off",
      "unused-imports/no-unused-imports": "error",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_",
        },
      ],
    },
  },
  {
    // `headcanon/testing` must load without a test framework; only the suites
    // and the entries that publish them may import one. `src/testing/index.test.ts`
    // checks the entry's whole import graph at run time; this rule names the
    // offending file at lint time.
    files: ["src/testing/**/*.ts"],
    ignores: [
      "src/testing/suites/**",
      "src/testing/contracts.ts",
      "src/testing/react.ts",
      "src/testing/**/*.test.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["vitest", "vitest/*", "@testing-library/*"],
              message:
                "Test doubles must not import a test framework. Put suites in src/testing/suites/.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["**/*.mjs"],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    ignores: [
      ".claude/**",
      "**/dist/**",
      "**/coverage/**",
      "fixture/.next/**",
      "fixture/next-env.d.ts",
      "fixture/playwright-report/**",
      "fixture/test-results/**",
    ],
  },
  // Last, so it turns off every formatting rule the configs above enable.
  eslintConfigPrettier,
]
