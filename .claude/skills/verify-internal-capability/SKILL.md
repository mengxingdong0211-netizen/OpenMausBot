---
name: verify-internal-capability
description: "Formally check that a warm-engine internal capability bearer never lets a previous turn's in-flight /api/internal call commit under the next turn. Use when changing sessionBearer, mintInternalCapability, revokeInternalCapabilityGeneration, authorizedInternalCapability, internalCapabilityIsActive, readInternalBody, requireActiveInternalCapability, beginInternalCapabilityGeneration, or any /api/internal route that trusts that bearer."
---

# Verify internal capability turn boundary

## Property

A tool call that left the engine during turn G1 must not commit as turn G2's work when the same bearer is reminted for G2.

Harm if broken: a late agents, connectors, hooks, phone, data, or desktop-computer internal call from an ended turn can create cards, stage skills, post, or otherwise act as the new turn.

## When to run

Run this skill before claiming a change is safe if the diff touches any of:

- `server/index.ts`: `sessionGrants`, `sessionBearer`, `mintInternalCapability`, `beginInternalCapabilityGeneration`, `revokeInternalCapabilityGeneration`, `revokeEarlierTurnCapabilities`, `revokeInternalCapabilitiesForThread`, `authorizedInternalCapability`, `internalCapabilityIsActive`, `readInternalBody`, `requireActiveInternalCapability`
- Warm-engine launch paths that pass `OMB_COMMS_TOKEN` / internal bearers across turns
- Tests that claim a late internal body is refused after the turn is replaced

If none of those moved, say so and stop.

## Coverage record

| Check | Code |
|---|---|
| Stable bearer reuse when grants and approval match | `sessionGrants`, `sessionBearer` |
| Per-turn record behind the bearer | `mintInternalCapability` |
| Revoke deletes the previous generation's record, keeps session credentials | `revokeInternalCapabilityGeneration`, `revokeEarlierTurnCapabilities` |
| Lookup + active check | `authorizedInternalCapability`, `internalCapabilityIsActive` |
| Post-authorize recheck before side effects | `readInternalBody`, `requireActiveInternalCapability` |

Last synced to code at commit: `88d54eb17a3655b968470cbbf3b5097de225a8b5`

Move that commit forward only after you re-run the check below and confirm the model and mirror still describe those functions.

## Tool and why

TLC (TLA+ model checker) over `formal/internal-capability/InternalCapability.tla`. The failure is an ordering of steps, not a single input, so a model checker over a small state machine is cheaper than a proof and stronger than the one arrival order the unit test covers.

Bounds: one thread, one stable-bearer kind (`agents`), two generations, two in-flight requests. Orphan expiry, `perTurn` computer/browser tokens, external-runtime grants, and grant/approval changes that already rotate the bearer are out of scope.

## Commands

Needs Java 17+ on `PATH`. The runner downloads `formal/tools/tla2tools.jar` (TLA+ tools 1.8.0) on first use.

```sh
node formal/internal-capability/run.mjs check
node formal/internal-capability/mirror.mjs race
node formal/internal-capability/mirror.mjs break-recheck
```

Read every TLC result with the pstack `/statechart` skill. It shows each invariant violation as its shortest path in plain words, and draws the state chart when the check passes.

## How to read the result

`run.mjs check` expects today's shape:

1. **Current model** (`RotateBearerOnGeneration = FALSE`, matching `server/index.ts`): `NoCrossGenerationCommit` is **violated**.
2. **Repair model** (`RotateBearerOnGeneration = TRUE`): the invariant **holds**.
3. **JS mirror** `race`: current admits the cross-generation commit; repair refuses it.

That violation is a real finding, not a modeling error. Do not weaken the invariant. Do not change product code unless the operator asks. Report the counterexample in code nouns:

1. `beginInternalCapabilityGeneration(G1)` then `mintInternalCapability` → bearer `T`.
2. Engine starts `/api/internal/*` with `Authorization: Bearer T` while the body is still unread.
3. `revokeInternalCapabilityGeneration(G1)`, then `beginInternalCapabilityGeneration(G2)`, then `mintInternalCapability` reuses `T` under G2.
4. `authorizedInternalCapability(T)` returns the G2 record; the recheck passes; the G1 call commits as G2.

The existing test `binds profile proposals to the capability's bot and thread and rechecks late bodies` in `server/index.test.ts` only covers lookup-then-remint. TLC's failing order is remint-then-lookup.

If the current model starts holding without a product fix that retires or binds the bearer across generations, treat that as drift: the model no longer matches the code. Re-read the covered functions and update the model before moving the sync commit.

If the repair model starts failing, the model itself regressed. Fix the TLA or mirror, not the invariant.

## Update after an intentional change

When a change is meant to close the finding (for example clearing `sessionCredentials` on generation revoke, or otherwise refusing remint-then-lookup), update `InternalCapability.tla` / the mirror so the current cfg matches the new code, re-run `node formal/internal-capability/run.mjs check`, and only then move the sync commit in this skill. Until then, keep reporting the open finding.
