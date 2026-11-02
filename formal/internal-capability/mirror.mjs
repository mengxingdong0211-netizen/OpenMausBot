#!/usr/bin/env node
// Tiny mirror of server/index.ts sessionBearer / mint / revoke / authorize /
// recheck. Used to replay the TLC counterexample in code nouns and to catch a
// scratch break of the generation gate.

export function createCapabilityStore({ rotateBearerOnGeneration = false } = {}) {
  let activeGen = null;
  const capabilities = new Map();
  const sessionCredentials = new Map();

  function sessionGrants(capability) {
    const { generation: _turn, ...grants } = capability;
    return JSON.stringify(grants);
  }

  function sessionBearer(capability) {
    const slot = `${capability.botId} ${capability.kind}`;
    const held = sessionCredentials.get(slot);
    const grants = sessionGrants(capability);
    if (held?.grants === grants) return held.token;
    const token = `tok-${sessionCredentials.size + 1}-${capability.generation}`;
    sessionCredentials.set(slot, { grants, token });
    return token;
  }

  function beginGeneration(generation) {
    if (activeGen) revokeGeneration(activeGen);
    activeGen = generation;
    return generation;
  }

  function mint(capability) {
    if (activeGen !== capability.generation) {
      throw new Error("cannot mint an integration capability for an inactive turn");
    }
    const token = sessionBearer(capability);
    if (capabilities.get(token)?.generation !== capability.generation) {
      capabilities.set(token, { ...capability });
    }
    return token;
  }

  function revokeGeneration(generation) {
    for (const [token, capability] of capabilities) {
      if (capability.generation === generation) capabilities.delete(token);
    }
    if (activeGen === generation) activeGen = null;
    if (rotateBearerOnGeneration) sessionCredentials.clear();
  }

  function isActive(capability) {
    return activeGen === capability.generation;
  }

  function authorize(headerToken) {
    for (const [token, capability] of capabilities) {
      if (!isActive(capability)) {
        capabilities.delete(token);
        continue;
      }
      if (token === headerToken) return capability;
    }
    return null;
  }

  function commit(capability) {
    return isActive(capability);
  }

  return {
    beginGeneration,
    mint,
    revokeGeneration,
    authorize,
    commit,
    get activeGen() {
      return activeGen;
    },
  };
}

function replayCrossGenerationRace({ rotateBearerOnGeneration = false } = {}) {
  const store = createCapabilityStore({ rotateBearerOnGeneration });
  const grants = {
    botId: "bot",
    threadId: "thread",
    kind: "agents",
    depth: 0,
    skillAuthoring: false,
    createdBots: 0,
    openedThreads: 0,
  };

  store.beginGeneration("G1");
  const tokenG1 = store.mint({ ...grants, generation: "G1" });

  const produceGen = "G1";
  const bearer = tokenG1;

  store.beginGeneration("G2");
  const tokenG2 = store.mint({ ...grants, generation: "G2" });

  const authorized = store.authorize(bearer);
  const committed = authorized ? store.commit(authorized) : false;
  return {
    produceGen,
    bearer,
    tokenG2,
    sameBearer: bearer === tokenG2,
    authGen: authorized?.generation ?? null,
    committed,
    crossGeneration: committed && authorized.generation !== produceGen,
  };
}

const mode = process.argv[2] ?? "race";

if (mode === "race") {
  const current = replayCrossGenerationRace({ rotateBearerOnGeneration: false });
  const fixed = replayCrossGenerationRace({ rotateBearerOnGeneration: true });
  console.log(JSON.stringify({ current, fixed }, null, 2));
  if (!current.crossGeneration) {
    console.error("expected current code mirror to admit a cross-generation commit");
    process.exit(1);
  }
  if (fixed.crossGeneration || fixed.committed) {
    console.error("expected rotate-bearer repair to refuse the late G1 call");
    process.exit(1);
  }
  process.exit(0);
}

if (mode === "break-recheck") {
  const store = createCapabilityStore({ rotateBearerOnGeneration: false });
  const grants = {
    botId: "bot",
    threadId: "thread",
    kind: "agents",
    depth: 0,
    skillAuthoring: false,
    createdBots: 0,
    openedThreads: 0,
  };
  store.beginGeneration("G1");
  const token = store.mint({ ...grants, generation: "G1" });
  const authorized = store.authorize(token);
  store.beginGeneration("G2");
  store.mint({ ...grants, generation: "G2" });
  const brokenCommit = Boolean(authorized);
  const safeCommit = store.commit(authorized);
  console.log(JSON.stringify({ brokenCommit, safeCommit, authGen: authorized?.generation }, null, 2));
  if (!brokenCommit || safeCommit) {
    console.error("scratch break did not diverge from the recheck");
    process.exit(1);
  }
  process.exit(0);
}

console.error(`unknown mode: ${mode}`);
process.exit(2);
