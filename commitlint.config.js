/**
 * Commitlint configuration.
 *
 * Extends @commitlint/config-conventional but relaxes subject-case to allow
 * uppercase subjects. This project uses "US-NNN" prefixes in commit subjects
 * (e.g. "feat: US-001 - Cross-file inheritance lookup") which the default
 * subject-case rule rejects.
 */
export default {
  extends: ["@commitlint/config-conventional"],
  rules: {
    "subject-case": [2, "never", ["start-case", "pascal-case"]],
  },
};
