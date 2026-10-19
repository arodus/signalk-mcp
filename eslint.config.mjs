import js from "@eslint/js";
import tseslint from "typescript-eslint";
export default tseslint.config(
  { ignores: ["dist/**", "public/**", "node_modules/**"] },
  {
    files: ["ui/**/*.mjs"],
    languageOptions: {
      globals: { fetch: "readonly", AbortSignal: "readonly" },
    },
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["test/**/*.cjs", "webpack.config.cjs"],
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
