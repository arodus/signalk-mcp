import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist/**", "node_modules/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["test/**/*.cjs"],
    languageOptions: {
      globals: {
        __dirname: "readonly",
        require: "readonly",
        module: "readonly",
        process: "readonly",
        fetch: "readonly",
        setTimeout: "readonly",
        URL: "readonly",
        AbortSignal: "readonly",
        AbortController: "readonly",
      },
    },
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
);
