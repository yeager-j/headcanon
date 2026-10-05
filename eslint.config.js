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
  eslintConfigPrettier,
  ...tseslint.configs.recommended,
  {
    files: ["fixture/**/*.{ts,tsx}"],
    ...pluginReact.configs.flat.recommended,
    languageOptions: {
      ...pluginReact.configs.flat.recommended.languageOptions,
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ["fixture/**/*.{ts,tsx}"],
    plugins: {
      "@next/next": pluginNext,
      "react-hooks": pluginReactHooks,
    },
    settings: {
      next: { rootDir: "fixture" },
      react: { version: "detect" },
    },
    rules: {
      ...pluginNext.configs.recommended.rules,
      ...pluginNext.configs["core-web-vitals"].rules,
      ...pluginReactHooks.configs.recommended.rules,
      // The new JSX transform makes React scope unnecessary.
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
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
    files: ["**/*.mjs"],
    languageOptions: {
      globals: { URL: "readonly", console: "readonly", process: "readonly" },
    },
  },
  {
    ignores: [
      "**/dist/**",
      "**/coverage/**",
      "fixture/.next/**",
      "fixture/next-env.d.ts",
      "fixture/playwright-report/**",
      "fixture/test-results/**",
    ],
  },
]
