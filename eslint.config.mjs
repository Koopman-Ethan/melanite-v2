import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";
import jsxA11y from "eslint-plugin-jsx-a11y";

// Accessibility rules at lint time — the cheapest of the three layers.
//
// It catches what is obvious from the source alone: a label pointing at nothing, a click
// handler on a div, an image with no alt text. Those get fixed before they reach a browser,
// let alone a person using a screen reader.
//
// It cannot see contrast (`npm run a11y:contrast`), focus order, or whether a control is
// actually reachable by keyboard. Those need the page rendered.
//
// Set to error rather than warn: a warning in a project this size is a thing nobody reads.
const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    // Rules only — `eslint-config-next` already registers the jsx-a11y plugin, and redefining
    // it is a hard config error. This turns on the strict rule set it ships with a subset of.
    files: ["**/*.tsx"],
    rules: {
      ...jsxA11y.flatConfigs.strict.rules,
      // Off deliberately: Next's <Link> renders an anchor the rule cannot always resolve, and
      // this app has no anchor standing in for a button.
      "jsx-a11y/anchor-is-valid": "off",
      // A <label> wrapping its own checkbox is implicitly associated and announces its whole
      // text content. The rule only looks two elements deep by default, which misses the
      // pattern used for consent checkboxes here — a heading span and a description span inside
      // a wrapper. The markup is correct; the default depth is just conservative.
      "jsx-a11y/label-has-associated-control": ["error", { depth: 3 }],
      // A horizontally scrollable table must be focusable or a keyboard user cannot scroll it —
      // axe flags exactly that as `scrollable-region-focusable`. The default rule config
      // disallows tabIndex on a div regardless, so the two tools contradict each other. axe is
      // right: the pattern is div[role=region][tabindex=0] wrapping the overflow, and this
      // permits it for that role only.
      "jsx-a11y/no-noninteractive-tabindex": ["error", { tags: [], roles: ["region"] }],
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
