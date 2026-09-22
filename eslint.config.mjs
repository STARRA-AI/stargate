import { dirname } from "path";
import { fileURLToPath } from "url";
import { FlatCompat } from "@eslint/eslintrc";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const compat = new FlatCompat({
  baseDirectory: __dirname,
});

const eslintConfig = [
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      // The prod / verify / turbo build lanes emit compiled bundles that are not
      // source. Measured 2026-09-15: linting them reported 33,512 problems across
      // 574 files, 570 of which were .next-prod / .next-prod-new output, including
      // 1,766 ERRORS that were all generated code. Ignoring them leaves 86
      // warnings in 4 real files and 0 errors — which is a gate again.
      ".next-*/**",
      ".starra-turbo/**",
      "out/**",
      "build/**",
      "next-env.d.ts",
      "public/vendor/**",
      "vendor/**",
    ],
  },
];

export default eslintConfig;
