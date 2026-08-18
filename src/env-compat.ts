/**
 * Snowcat ADR-0064 compatibility window: the product was named Snowcat, so
 * every environment variable was `SNOWCAT_*`. `SNOWCAT_*` is now the name; for
 * one release a process still adopts any `SNOWCAT_*` variable whose `SNOWCAT_*`
 * twin is unset, and says so once on stderr, so a host or client that has not
 * been migrated keeps working. Every entry point calls this before reading
 * its configuration; library code reads only `SNOWCAT_*`.
 */
const LEGACY_PREFIX = "SNOWCAT_";
const PREFIX = "SNOWCAT_";

export function adoptLegacyEnvironment(env: NodeJS.ProcessEnv = process.env, warn: (line: string) => void = (line) => console.error(line)): string[] {
  const adopted: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_PREFIX) || value === undefined) continue;
    const modern = PREFIX + key.slice(LEGACY_PREFIX.length);
    if (env[modern] === undefined) {
      env[modern] = value;
      adopted.push(key);
    }
  }
  if (adopted.length > 0) {
    warn(`snowcat: adopted legacy ${adopted.sort().join(", ")}; rename to ${PREFIX}* (SNOWCAT_* is read for one release only)`);
  }
  return adopted;
}
