# Chat screen

The chat screen lets a person type in the composer's message box, press Enter, and see that text plus the bot's reply in the conversation.

## Sub-features

- `ui-open` opens the isolated renderer on the seeded bot Pepper.
- `ui-compose` types into the one textbox named `Message Pepper`.
- `ui-send` sends that draft with Enter.
- `ui-transcript` shows the sent text and the fake reply inside `Conversation with Pepper`.

## How to get to it (user POV)

- Open the desktop app and select a bot. The composer is the box labeled for that bot. Enter sends.
- The fixture mounts the same React app in a headless browser, on a bot the launcher named Pepper, and drives it by accessible name.

## Driving it with control-omb

Preconditions:

- No other `ui launch` is running.
- Doctor for a headless `launch` is not required first: `ui launch` starts its own fixture. Do not point these verbs at a server you did not get a `ui` handle from.
- The first run on a machine may download the pinned agent-browser binary and Chrome into `.omb-scratch/verify-tools`. That directory is gitignored. The download needs a network.
- Evidence files are written under `/tmp/openmausbot-verification-evidence/runs/PID/`. `ui launch` does not print `pid`; take it from `GET /api/health`.

- **Open the app.** Start the foreground launcher. Run `node --experimental-strip-types scripts/control-omb.ts ui launch`. Ready is JSON with `ok` true, a `ui` path ending in `ui.json`, a loopback `url`, `previewUrl` ending in `/__threads.html`, `botId`, `dataDir`, and `logPath`. The bot is Pepper. Leave this process in the foreground.
- **Check the handle.** Run `curl -sS "$URL/api/health"` and use its `pid` with the printed `url` and `dataDir`. Run `node .cursor/skills/verify-omb/helpers/doctor.mjs --url "$URL" --pid "$PID" --data-dir "$DATA_DIR"`. Exit 0.
- **See the composer.** Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name snapshot-before --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts ui snapshot --ui "$UI_HANDLE" --interactive`. The snapshot text contains one textbox `Message Pepper`.
- **Type and send.** Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name type-hello --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts ui type --ui "$UI_HANDLE" --name "Message Pepper" --text hello` and then `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name press-enter --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts ui press --ui "$UI_HANDLE" --keys Enter`. Both exit 0.
- **Wait for the reply.** Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name wait-settle --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts ui wait-settle --ui "$UI_HANDLE" --timeout 60`. Exit 0.
- **Read the transcript.** Run `node .cursor/skills/verify-omb/helpers/record.mjs --evidence "$EVIDENCE" --name snapshot-after --data-dir "$DATA_DIR" -- node --experimental-strip-types scripts/control-omb.ts ui snapshot --ui "$UI_HANDLE"`. Inside the landmark `log "Conversation with Pepper"`, the tree contains `StaticText "hello"` and `StaticText "hello from fake claude"`.
- **Capture the screen.** Run `node --experimental-strip-types scripts/control-omb.ts ui screenshot --ui "$UI_HANDLE" --out "$EVIDENCE/chat-ui.png"`. The PNG is outside `dataDir` and shows Pepper's conversation.

## Gotchas

- Every `ui` verb takes `--ui` set to the printed handle. There is no discovery. A handle from a previous launch is not valid after Ctrl-C.
- The composer name follows the bot: `Message Pepper` only because `ui launch` seeds Pepper. A bot named Probe would be `Message Probe`.
- `ui launch` must own the terminal so Ctrl-C can delete its `dataDir`. Do not start it under `pnpm`.
- The Bash chip in the transcript is off until `ui flag --ui "$UI_HANDLE" --set features.showToolCalls=true`. This recipe does not require that chip. The reply text does not depend on the flag.
- The sidebar also previews the latest reply. Read the `Conversation with Pepper` landmark, not the first matching string in the whole tree.
- `ui press --keys Enter` sends. Typing the word Enter into the composer does not.
- This recipe does not open the Electron window, the tray, or a real provider login. A missing network on first launch fails in the browser download; report that, and do not fall back to `send --bot` and call the chat screen proven.
