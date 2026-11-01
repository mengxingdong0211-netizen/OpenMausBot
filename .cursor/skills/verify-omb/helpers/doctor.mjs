#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

function flag(name) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    process.stderr.write(`missing ${name}\n`);
    process.exit(2);
  }
  return value;
}

const major = Number(process.versions.node.split(".")[0]);
if (!Number.isInteger(major) || major < 24) {
  process.stderr.write(`node ${process.versions.node} is below the required Node 24\n`);
  process.exit(2);
}

const urlText = flag("--url");
const pid = Number(flag("--pid"));
const dataDir = flag("--data-dir");
const problems = [];

let url;
try {
  url = new URL(urlText);
} catch {
  problems.push(`url is not parseable: ${urlText}`);
}
if (url && (url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port)) {
  problems.push("url must be http://127.0.0.1:PORT");
}
if (!Number.isInteger(pid) || pid <= 1) problems.push("--pid must be the launch JSON pid");

const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"));
if (packageJson.name !== "openmausbot") problems.push(`repo root is not openmausbot (${repoRoot})`);

let health = null;
if (url && problems.length === 0) {
  try {
    const response = await fetch(`${url.origin}/api/health`, { signal: AbortSignal.timeout(5_000) });
    health = await response.json();
  } catch (error) {
    problems.push(`GET /api/health failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
if (health && health.app !== "openmausbot") problems.push(`health.app is ${JSON.stringify(health.app)}`);
if (health && health.pid !== pid) problems.push(`health.pid ${health?.pid} does not match launch pid ${pid}`);
if (health && health.static !== false) problems.push("health.static is not false; this is not the fake-engine fixture");

let resolvedData = null;
try {
  resolvedData = realpathSync(dataDir);
} catch {
  problems.push(`dataDir does not exist: ${dataDir}`);
}
if (resolvedData) {
  const home = realpathSync(homedir());
  if (basename(resolvedData).startsWith("openmausbot-verify-data-") === false) {
    problems.push(`dataDir basename is not openmausbot-verify-data-*: ${resolvedData}`);
  }
  if (resolvedData === home || resolvedData.startsWith(`${home}/`)) {
    problems.push("dataDir is inside the user home");
  }
}

// Linux exposes the server's environment in /proc/<pid>/environ; other platforms check the health pid only.
const environPath = `/proc/${pid}/environ`;
if (process.platform === "linux" && resolvedData && url) {
  if (!existsSync(environPath)) problems.push(`no process environ at ${environPath}`);
  else {
    const environ = readFileSync(environPath, "utf8").split("\0");
    if (!environ.includes(`OMB_PORT=${url.port}`)) problems.push(`pid ${pid} is not the fixture on port ${url.port}`);
    const printedData = resolve(dataDir);
    const ownsData = environ.includes(`OMB_DATA_DIR=${resolvedData}`) || environ.includes(`OMB_DATA_DIR=${printedData}`);
    if (!ownsData) problems.push(`pid ${pid} OMB_DATA_DIR is not ${printedData}`);
  }
}

let doctor = null;
if (problems.length === 0) {
  const run = spawnSync(
    process.execPath,
    ["--experimental-strip-types", "scripts/control-omb.ts", "doctor", "--url", url.origin],
    { cwd: repoRoot, encoding: "utf8" },
  );
  if (run.error) problems.push(`doctor failed to start: ${run.error.message}`);
  else {
    try {
      doctor = JSON.parse(run.stdout);
    } catch {
      problems.push(`doctor stdout was not JSON (exit ${run.status}): ${run.stdout.slice(0, 400)}`);
    }
    if (run.status !== 0) problems.push(`doctor exited ${run.status}`);
  }
}

if (doctor) {
  if (doctor.ok !== true) problems.push("doctor.ok is not true");
  if (doctor.health?.app !== "openmausbot") problems.push("doctor health app is not openmausbot");
  if (doctor.health?.endpoint !== url?.origin) problems.push(`doctor endpoint ${doctor.health?.endpoint} != ${url?.origin}`);
  if (doctor.health?.packaged !== false) problems.push("doctor reports a packaged server");
  if (!Array.isArray(doctor.availableEngines) || !doctor.availableEngines.includes("claude")) {
    problems.push(`claude is not available (${JSON.stringify(doctor.availableEngines)})`);
  }
  if (doctor.server?.version !== packageJson.version) {
    problems.push(`server version ${doctor.server?.version} != package ${packageJson.version}`);
  }
  if (doctor.server?.capabilities?.jobs !== true) problems.push("server cannot report jobs");
  if (doctor.session?.kind !== "loopback") problems.push(`session kind is ${doctor.session?.kind}, not loopback`);
  if (!Array.isArray(doctor.session?.scopes) || !doctor.session.scopes.includes("admin")) {
    problems.push("session is not an owner (admin) session");
  }
  if (Array.isArray(doctor.problems) && doctor.problems.length > 0) {
    problems.push(...doctor.problems.map((item) => `doctor problem: ${item}`));
  }
}

const summary = {
  ok: problems.length === 0,
  url: url?.origin ?? urlText,
  pid,
  dataDir: resolvedData,
  version: doctor?.server?.version ?? null,
  availableEngines: doctor?.availableEngines ?? [],
  sessionKind: doctor?.session?.kind ?? null,
  browser: doctor?.browser?.kind ?? null,
  warnings: doctor?.warnings ?? [],
  ...(problems.length ? { problems } : {}),
};
const encoded = `${JSON.stringify(summary, null, 2)}\n`;
if (problems.length) {
  process.stderr.write(encoded);
  process.exit(1);
}
process.stdout.write(encoded);
