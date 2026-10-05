import { config } from "@workspace/eslint-config/base"

export default [
  ...config,
  {
    files: ["*.mjs"],
    languageOptions: {
      globals: { URL: "readonly", console: "readonly", process: "readonly" },
    },
  },
]
