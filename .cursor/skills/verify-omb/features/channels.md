# Channels

Channels lets a person put two bots in a room, send one message in that room, and read the room's reply from the room transcript.

## Sub-features

- `channel-create` makes a room from two existing bots.
- `channel-send` posts one message into the room's active task.
- `channel-settle` waits on the room, not on a member bot.
- `channel-read` reads the room transcript, including the sent text and a bot reply.

## How to get to it (user POV)

- In the app, create a channel from the sidebar, choose its member bots, and send from the channel composer.
- From a terminal, run `openmausbot new-channel`, `openmausbot send` to that room, `openmausbot wait`, and `openmausbot messages`.
- The fixture path uses `new-channel`, `send-channel`, `wait --channel`, and `messages --channel`.

## Driving it with control-omb

Preconditions:

- The doctor helper exits 0 for this launch.
- `FAKE_CLAUDE_MODE` is unset or `happy`, and `FAKE_CLAUDE_ROOM_PLAN` is unset.
- Two bots exist that this run created. Their ids are `BOT_A` and `BOT_B`.
- No channel is already named `Review`.

- **Create two bots.** Run `new-bot --name Ada --url "$URL"` and `new-bot --name Bev --url "$URL"`, each through `record.mjs` with names `new-bot-ada` and `new-bot-bev`. Both exit 0 and return distinct `bot.id` values.
- **Create the room.** Choose those two members. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name new-channel --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts new-channel --name Review --members "$BOT_A,$BOT_B" --url "$URL"`. Exit 0, `channel.name` is `Review`, and `channel.id` is the id used below.
- **Send in the room.** Type `Reply once` and send. Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name send-channel --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts send-channel --channel "$CHANNEL_ID" --text "Reply once" --url "$URL"`. Exit 0 and `success` is true.
- **Wait on the room.** Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name wait-channel --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts wait --channel "$CHANNEL_ID" --timeout 60 --url "$URL"`. Exit 0 and `status` is `settled`.
- **Read the room.** Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name channel-messages --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts messages --channel "$CHANNEL_ID" --limit 20 --url "$URL"`. The messages include the user text `Reply once` and a later bot `kind` `text` message `hello from fake claude`.

## Gotchas

- Wait with `--channel CHANNEL_ID`. Waiting on a member bot while that bot is speaking for the room is the wrong conversation.
- `--members` takes unique bot ids or unique names, comma-separated, with no spaces required. A name that matches two bots is refused; pass ids.
- `Fixture Starter` is a legal member, and its greeting is a different conversation. This recipe uses Ada and Bev so the room transcript is not that greeting.
- The same fast fake reply can settle before `wait` attaches. `status` `settled` plus the room transcript is the proof.
- Setting `FAKE_CLAUDE_ROOM_PLAN` replaces the happy-mode reply. This recipe expects that variable to be unset. If a run set it, the transcript will not contain `hello from fake claude`; report that precondition instead of changing the expected text.
- A card that needs an answer returns `needs-user`. That is not a settled reply.
