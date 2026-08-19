import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { childEnvironment } from "./helpers/child-environment.ts";

const UPGRADE = join(process.cwd(), "deploy", "upgrade.sh");

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: childEnvironment({
      GIT_AUTHOR_NAME: "test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    }),
  });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

test("deploy/upgrade.sh re-runs itself when the pull changes it, so the steps after the pull are the new commit's", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-deploy-upgrade-test-"));
  const origin = join(directory, "origin.git");
  const author = join(directory, "author");
  const host = join(directory, "host");
  const bin = join(directory, "bin");
  const npmLog = join(directory, "npm.log");

  // Stub npm: log what it was asked to do, exit 0. systemctl is stubbed via SNOWCAT_SYSTEMCTL.
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> "${npmLog}"\nexit 0\n`);
  await chmod(join(bin, "npm"), 0o755);

  // Commit A: the current upgrade.sh. Commit B: upgrade.sh changed (a marker line after the pull).
  git(directory, "init", "--bare", "--initial-branch=main", origin);
  git(directory, "clone", "--quiet", origin, author);
  await mkdir(join(author, "deploy"), { recursive: true });
  const current = await readFile(UPGRADE, "utf8");
  await writeFile(join(author, "deploy", "upgrade.sh"), current);
  await chmod(join(author, "deploy", "upgrade.sh"), 0o755);
  git(author, "add", "-A");
  git(author, "commit", "--quiet", "-m", "A: current upgrade.sh");
  git(author, "push", "--quiet", "origin", "main");
  const commitA = git(author, "rev-parse", "HEAD");

  // The host clone sits at A.
  git(directory, "clone", "--quiet", origin, host);

  const marker = 'echo "upgrade: marker-from-B"';
  const anchor = 'echo "upgrade: restarted ${timers[*]}"';
  assert.ok(current.includes(anchor), "the anchor line exists in upgrade.sh");
  await writeFile(join(author, "deploy", "upgrade.sh"), current.replace(anchor, `${anchor}\n${marker}`));
  git(author, "add", "-A");
  git(author, "commit", "--quiet", "-m", "B: upgrade.sh prints a marker");
  git(author, "push", "--quiet", "origin", "main");
  const commitB = git(author, "rev-parse", "HEAD");

  const run = spawnSync("bash", [join(host, "deploy", "upgrade.sh")], {
    cwd: host,
    encoding: "utf8",
    env: childEnvironment({
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      SNOWCAT_SYSTEMCTL: "true",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    }),
  });
  assert.equal(run.status, 0, `upgrade.sh failed:\n${run.stdout}\n${run.stderr}`);
  const out = run.stdout;

  // The pull moved A -> B, the script noticed it changed itself, and the new version ran the rest.
  assert.match(out, new RegExp(`upgrade: ${commitA.slice(0, 12)} -> ${commitB.slice(0, 12)}`));
  assert.match(out, /upgrade: deploy\/upgrade\.sh changed in this pull; continuing with the new version/);
  assert.match(out, /upgrade: marker-from-B/);
  assert.equal(git(host, "rev-parse", "HEAD"), commitB);

  // The re-exec reports the whole upgrade (A -> B), not B -> B, and does not loop.
  assert.equal(out.match(/continuing with the new version/g)?.length, 1);
  assert.doesNotMatch(out, /already at/);

  // npm ran once per step — only in the new version, never twice.
  const npm = (await readFile(npmLog, "utf8")).trim().split("\n");
  assert.deepEqual(npm, ["npm ci", "npm run check"]);
});

test("deploy/upgrade.sh without a script change runs straight through once", async () => {
  const directory = await mkdtemp(join(tmpdir(), "snowcat-deploy-upgrade-same-test-"));
  const origin = join(directory, "origin.git");
  const host = join(directory, "host");
  const bin = join(directory, "bin");
  const npmLog = join(directory, "npm.log");
  await mkdir(bin, { recursive: true });
  await writeFile(join(bin, "npm"), `#!/bin/sh\necho "npm $*" >> "${npmLog}"\nexit 0\n`);
  await chmod(join(bin, "npm"), 0o755);
  git(directory, "init", "--bare", "--initial-branch=main", origin);
  git(directory, "clone", "--quiet", origin, host);
  await mkdir(join(host, "deploy"), { recursive: true });
  await writeFile(join(host, "deploy", "upgrade.sh"), await readFile(UPGRADE, "utf8"));
  await chmod(join(host, "deploy", "upgrade.sh"), 0o755);
  git(host, "add", "-A");
  git(host, "commit", "--quiet", "-m", "A");
  git(host, "push", "--quiet", "origin", "main");

  const run = spawnSync("bash", [join(host, "deploy", "upgrade.sh")], {
    cwd: host,
    encoding: "utf8",
    env: childEnvironment({ PATH: `${bin}:${process.env.PATH ?? ""}`, SNOWCAT_SYSTEMCTL: "true", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" }),
  });
  assert.equal(run.status, 0, `upgrade.sh failed:\n${run.stdout}\n${run.stderr}`);
  assert.match(run.stdout, /already at/);
  assert.doesNotMatch(run.stdout, /continuing with the new version/);
  assert.deepEqual((await readFile(npmLog, "utf8")).trim().split("\n"), ["npm ci", "npm run check"]);
});
