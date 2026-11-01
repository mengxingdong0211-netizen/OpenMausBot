#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function flag(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

const evidence = flag("--evidence");
const name = flag("--name");
const dataDir = flag("--data-dir");
const split = process.argv.indexOf("--");
const command = split === -1 ? [] : process.argv.slice(split + 1);
if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
  process.stderr.write("--name must be lowercase words separated by single hyphens\n");
  process.exit(2);
}
if (command.length === 0) {
  process.stderr.write("usage: record.mjs --evidence DIR --name LABEL --data-dir DIR -- COMMAND...\n");
  process.exit(2);
}

const evidenceDir = resolve(evidence);
const fixtureDir = realpathSync(dataDir);
const relation = relative(fixtureDir, evidenceDir);
if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
  process.stderr.write(`evidence path ${evidenceDir} is inside the fixture data dir\n`);
  process.exit(2);
}

mkdirSync(evidenceDir, { recursive: true });
const run = spawnSync(command[0], command.slice(1), { encoding: "utf8" });
const exitCode = run.error ? 127 : run.status ?? 1;
const payload = {
  command,
  exitCode,
  stdout: run.stdout ?? "",
  stderr: `${run.stderr ?? ""}${run.error ? `${run.error.message}\n` : ""}`,
};
const file = resolve(evidenceDir, `${name}.json`);
writeFileSync(file, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(payload.stdout);
process.stderr.write(payload.stderr);
process.stderr.write(`recorded ${file} exit ${exitCode}\n`);
process.exit(exitCode);
