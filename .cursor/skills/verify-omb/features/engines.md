# Engines and model choice

Engines and model choice lets a person see that a model provider is ready and switch one bot onto another model from that provider.

## Sub-features

- `engine-ready` reports the fixture server ready with the Claude instance available.
- `engine-list` lists that instance's models, including the default and an alternate.
- `engine-switch` changes one idle bot from the default model to another listed model.
- `engine-read` shows the new model on a later read of that bot.

## How to get to it (user POV)

- Open a bot's model picker, or Settings, then Engines.
- From a terminal, run `openmausbot doctor`, `openmausbot models`, and `openmausbot set-model`.
- The fixture path uses `doctor`, `models`, and `set-model` on the isolated URL. It does not sign in to a provider.

## Driving it with control-omb

Preconditions:

- The doctor helper exits 0. Its JSON includes `claude` in `availableEngines` and may warn that agent-browser is not installed.
- A bot named Probe exists and is idle (`turn-create` in [Chat turns](./chat-turns.md), or a fresh `new-bot --name Probe`).
- No turn is running on Probe. `set-model` without `--task` updates the bot default and its selected idle task.

- **Doctor.** Open the readiness check. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name doctor --data-dir "$DATA_DIR" -- node .cursor/skills/verify-omb/helpers/doctor.mjs --url "$URL" --pid "$PID" --data-dir "$DATA_DIR"`. Exit 0, `ok` is true, `sessionKind` is `loopback`, and `version` matches this checkout.
- **List models.** Open the model list. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name models --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts models --url "$URL"`. The `claude` instance has `snapshot.state` `available`, `models.default` `claude-sonnet-5`, and an option id `claude-haiku-4-5`.
- **Switch model.** Choose Claude Haiku 4.5 for Probe. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name set-model --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts set-model --bot "$BOT_ID" --instance claude --model claude-haiku-4-5 --url "$URL"`. Exit 0.
- **Read it back.** Open the bot list. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name bots --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts bots --url "$URL"`. Probe's `modelSelection.instanceId` is `claude` and `modelSelection.model` is `claude-haiku-4-5`.

## Gotchas

- `doctor.ok` stays true when the only warning is a missing built-in browser. Do not install agent-browser just to make that warning disappear. Chat screen coverage is a separate recipe.
- The fixture's available engine is the fake CLI displayed as `Verification fixture` with instance id `claude`. Other instance ids in `models` are `unavailable`. Do not `set-model` onto one of those and call the picker proven.
- Model ids are the `options[].id` values. `claude-haiku-4-5` is one of them. A label such as `Claude Haiku 4.5` is not the id `set-model` accepts.
- This recipe never proves an OAuth login or a live Claude account. The fake engine remains the process that answers chats.
- `set-model --dry-run` does not change `modelSelection`. Read the bot back after a real `set-model`.
