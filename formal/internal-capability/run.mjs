#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pipeline } from "node:stream/promises";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const jar = join(root, "tools", "tla2tools.jar");
const jarUrl = "https://github.com/tlaplus/tlaplus/releases/download/v1.8.0/tla2tools.jar";

async function ensureJar() {
  if (existsSync(jar)) return;
  mkdirSync(dirname(jar), { recursive: true });
  const res = await fetch(jarUrl);
  if (!res.ok || !res.body) {
    throw new Error(`failed to download tla2tools.jar: ${res.status}`);
  }
  await pipeline(res.body, createWriteStream(jar));
}

function runTlc(configName) {
  const spec = join(here, "InternalCapability.tla");
  const config = join(here, configName);
  const result = spawnSync(
    "java",
    ["-XX:+UseParallelGC", "-cp", jar, "tlc2.TLC", "-config", config, "-workers", "auto", "-cleanup", spec],
    { encoding: "utf8" },
  );
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function summarize(label, result) {
  const text = `${result.stdout}\n${result.stderr}`;
  const violated = /Invariant .+ is violated/i.test(text);
  const success = /Model checking completed\. No error has been found/i.test(text);
  return { label, status: result.status, violated, success, text };
}

const mode = process.argv[2] ?? "check";

await ensureJar();

if (mode === "check") {
  const current = summarize("current", runTlc("InternalCapability.cfg"));
  const fixed = summarize("fixed", runTlc("InternalCapabilityFixed.cfg"));
  const mirror = spawnSync(process.execPath, [join(here, "mirror.mjs"), "race"], { encoding: "utf8" });

  console.log("=== TLC current (RotateBearerOnGeneration = FALSE) ===");
  console.log(current.text.trim());
  console.log("\n=== TLC fixed (RotateBearerOnGeneration = TRUE) ===");
  console.log(fixed.text.trim());
  console.log("\n=== JS mirror race replay ===");
  console.log((mirror.stdout || mirror.stderr || "").trim());

  const finding = current.violated && fixed.success && mirror.status === 0;
  if (!finding) {
    console.error("\nformal check did not match the known finding shape");
    console.error(JSON.stringify({
      current: { status: current.status, violated: current.violated, success: current.success },
      fixed: { status: fixed.status, violated: fixed.violated, success: fixed.success },
      mirrorStatus: mirror.status,
    }, null, 2));
    process.exit(1);
  }

  console.log(`
## Finding
Property: a tool call that left the engine during turn G1 must not commit as turn G2's work.
Tool: TLC on formal/internal-capability/InternalCapability.tla
Current code (stable session bearer): VIOLATED.
Repair (rotate bearer on generation): holds.

Counterexample shape (code nouns):
1. beginInternalCapabilityGeneration(G1); mintInternalCapability → bearer T
2. Engine starts an /api/internal/* call with Authorization: Bearer T (body still unread)
3. revokeInternalCapabilityGeneration(G1); beginInternalCapabilityGeneration(G2); mintInternalCapability reuses T under G2
4. authorizedInternalCapability(T) returns the G2 record; recheck passes; the G1 call commits as G2

Covered files: server/index.ts functions sessionGrants, sessionBearer, mintInternalCapability, revokeInternalCapabilityGeneration, authorizedInternalCapability, internalCapabilityIsActive, readInternalBody, requireActiveInternalCapability.
Not covered: perTurn computer/browser bearers, external-runtime grants, orphan expiry, grant/approval changes that already rotate the bearer.
`);
  process.exit(0);
}

if (mode === "fixed-only") {
  const fixed = summarize("fixed", runTlc("InternalCapabilityFixed.cfg"));
  console.log(fixed.text.trim());
  process.exit(fixed.success ? 0 : 1);
}

if (mode === "current-only") {
  const current = summarize("current", runTlc("InternalCapability.cfg"));
  console.log(current.text.trim());
  process.exit(current.violated ? 0 : 1);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
