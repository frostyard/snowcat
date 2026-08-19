/**
 * The environment for a child process started by a test: the current
 * process's environment with every ambient `SNOWCAT_*`, `FLUENT_*`, and
 * `FLUE_*` variable removed (the same filter as scripts/check-boot.mjs), then
 * the caller's explicit overrides applied — so a test gives the same answer on
 * a configured operator host (real SNOWCAT_CONTROL_DB, SNOWCAT_GITHUB_TOKEN,
 * …) as in CI, and never reaches a live database or credential by accident.
 * Undefined values are dropped, which is what child_process's `env` needs.
 */
export function childEnvironment(overrides: Record<string, string | undefined> = {}): Record<string, string> {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || /^(SNOWCAT|FLUENT|FLUE)_/.test(key)) continue;
    environment[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete environment[key];
    else environment[key] = value;
  }
  return environment;
}
