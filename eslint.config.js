import js from "@eslint/js";
import { defineConfig, globalIgnores } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  globalIgnores(["dist/", "node_modules/", "coverage/"]),
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      // URL.pathname stays percent-encoded ("dir%20with%20space"), so fs calls on it miss.
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.type='NewExpression'][object.callee.name='URL'][property.name='pathname']",
          message: "Use fileURLToPath(new URL(...)) for a filesystem path; URL.pathname is percent-encoded.",
        },
      ],
    },
  },
  {
    files: ["**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.eslint.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
