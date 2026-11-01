# Chat turns

Chat turns lets a person create a bot, type a message, and see that bot's reply in the same conversation.

## Sub-features

- `turn-create` creates a named bot and opens its conversation.
- `turn-send` accepts one message and returns without waiting for the reply.
- `turn-settle` waits until that conversation is no longer working.
- `turn-read` reads the sent text and the bot reply back from the conversation.

## How to get to it (user POV)

- In the desktop app, create a bot from the sidebar, type in its composer, and send.
- From a terminal, run `openmausbot new-bot`, `openmausbot send`, `openmausbot wait`, and `openmausbot messages` against this computer's server.
- The fixture path below uses those same verbs through `control-omb` against the isolated URL.

## Driving it with control-omb

Preconditions:

- The launch JSON is on stdout and the doctor helper exits 0.
- No bot is already named `Probe`. `Fixture Starter` may exist.
- `FAKE_CLAUDE_MODE` is unset or `happy`, so the reply text is `hello from fake claude`.
- Evidence goes to `/tmp/openmausbot-verification-evidence/runs/PID`.

- **Create the bot.** Choose a new bot named Probe. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name new-bot --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts new-bot --name Probe --url "$URL"`. Exit 0, `success` is true, `bot.name` is `Probe`, and `bot.id` is the id used below. `bot.modelSelection` is `claude` / `claude-sonnet-5`.
- **Send.** Type hello and send. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name send --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts send --bot "$BOT_ID" --text hello --url "$URL"`. Exit 0, `success` is true, and `messageId` is present. `taskId` matches `bot.activeTaskId` from the create result.
- **Wait.** Leave the conversation until the reply finishes. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name wait --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts wait --bot "$BOT_ID" --timeout 30 --url "$URL"`. Exit 0 and `status` is `settled`.
- **Read the reply.** Open the same conversation again. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name messages --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts messages --bot "$BOT_ID" --limit 10 --url "$URL"`. The `messages` array contains the user text `hello` and, later, a bot message with `kind` `text` and text `hello from fake claude`. The send `messageId` is that user row's `id`.
- **Confirm the engine saw it.** Run the Evidence dump check from the skill. `side-effect.json` records model `claude-sonnet-5`, `homeIsDataDir` true, and `promptHasHello` true.

## Gotchas

- The create step also stores a greeting, `Hi, I'm Probe. What would you like me to do?`. That row is not the reply to hello. Assert the bot text that comes after the user row.
- A fast fake reply often finishes before `wait` attaches. `status` is still `settled`, while `state` is `idle` and `job.reason` says nothing is running. Do not require `job.state` `completed`.
- Happy mode also writes a `Bash` activity and a digest line that quotes the reply. Those are scripted events, not a shell on this machine. The proof row is `kind: "text"`.
- `--dry-run` on `send` returns a plan and does not add hello to the transcript.
- Omitting `--task` uses the selected task. A second task needs `--task THREAD_ID` on send, wait, and messages.
- `needs-user`, `failed`, and `stalled` are not a successful reply. `status` `settled` with a bot text of `hello from fake claude` is the success condition for this recipe.
