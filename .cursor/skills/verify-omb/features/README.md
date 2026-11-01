# OpenMausBot verification map

This directory is the maintained source for verifying the user-facing behavior of OpenMausBot through `control-omb`. Read the index before driving the app, then use the matching feature file as the recipe.

## Baseline preconditions

- Node 24 or newer is the `node` on `PATH`.
- Launch from the repository root with `OMB_TEST_PORTS=19975-19999 node --experimental-strip-types scripts/control-omb.ts launch`.
- Keep the printed `url`, `pid`, `dataDir`, and `logPath`. The server is ready when that JSON appears.
- Run `node .cursor/skills/verify-omb/helpers/doctor.mjs --url URL --pid PID --data-dir DATA_DIR` and require exit 0.
- Record verb output under `/tmp/openmausbot-verification-evidence/runs/PID/`, never under `dataDir`.
- Never drive an instance that was not started by this verification run. Never use port `8799`, `18799`, or `28799` unless that port is the printed `url` and the doctor confirms the launch pid.

## Driving conventions

- Start every recipe from the baseline state unless its preconditions say otherwise.
- Pass `--url` on every `control-omb` verb. Mutating verbs do not search for a server.
- Invoke `node --experimental-strip-types scripts/control-omb.ts` so stdout is JSON. `pnpm control:omb` is the same program with a package banner in front of the JSON.
- Prefer ids from `new-bot` and `new-channel`, and accessible names from `ui snapshot`, over port discovery or screen coordinates.
- Treat every command as literal. Keep quoted names and flags unchanged.
- The seeded bot is named `Fixture Starter`. Recipes that need a person-created bot call `new-bot`.
- Restore nothing in the user's home. The fixture home is deleted on Ctrl-C. Do not remove proof artifacts during cleanup.

## Proof and skip reporting

- Capture the user action and the resulting state, not only the final screen.
- Headless proof is the recorded JSON for the verb and a later `messages` read of the same task.
- Renderer proof is an accessibility snapshot plus a screenshot stored under the evidence directory, with the composer name visible.
- Mutation proof includes the fake-engine dump check in the skill's Evidence section: model `claude-sonnet-5`, `HOME` equal to `dataDir`, and the prompt containing the sent text. Do not copy `env` or `mcpConfig` out of the dump.
- Record the feature id and entry point used with every artifact.
- Report an unreachable path with the attempted command and the unmet precondition.
- Do not report a skipped entry point as verified through a different path.

## Feature entry contract

Each feature file starts with an H1 title and one paragraph describing the user-visible behavior. It then uses exactly four H2 sections in this order.

1. `Sub-features` lists short IDs with one line for each behavior.
2. `How to get to it (user POV)` lists every user entry point.
3. `Driving it with control-omb` starts with `Preconditions:` and uses labeled bullets that pair each user action with an exact command and observable result.
4. `Gotchas` lists traps that can waste or invalidate a verification run.

Keep implementation details out of the map. Name only user paths, stable handles, required state, commands, and observable proof.

## Features

- [Chat turns](./chat-turns.md) covers creating a bot, sending a message, and reading the reply from a second fetch.
- [Channels](./channels.md) covers a room of two bots, a room send, and the room transcript.
- [Engines and model choice](./engines.md) covers Doctor, the model list, and switching one bot's model.
- [Chat screen](./chat-ui.md) covers the real renderer composer, a sent turn, and the transcript landmark.
