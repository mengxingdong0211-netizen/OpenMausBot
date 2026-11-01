---
name: verify-omb
description: "Drive an isolated OpenMausBot fake-engine fixture the way a person chats. Use when proving a chat turn, a channel, model choice, or the headless renderer. Never target a live app, port 8799, or ~/.openmausbot."
---

# Verify OpenMausBot

OpenMausBot is a local-first chat app (Electron shell plus the React renderer) for a team of bots. Verification drives an isolated server with the repository fake engine, through `scripts/control-omb.ts`. The desktop shell, tray, global shortcuts, microphone, and real provider logins are outside this skill.

Run every command from the repository root with Node 24 or newer (`node -v`). `package.json` requires that. The launcher uses `process.execPath`, so the `node` on `PATH` is the server that starts.

Two fixtures can run at once. Each launch binds a free loopback port and the next port for webhooks, with `HOME` and `OMB_DATA_DIR` set to a fresh `openmausbot-verify-data-*` directory. Pass disjoint `OMB_TEST_PORTS=LOW-HIGH` ranges when you want a known span. The default search is `19600`–`22599`. Never drive a process you did not start. Mutating verbs refuse to guess a port. The desktop app's own ports are `8799`, `18799`, and `28799`.

## Launch

```sh
node -v
OMB_TEST_PORTS=19975-19999 node --experimental-strip-types scripts/control-omb.ts launch
```

Do not start this through `pnpm`. pnpm swallows Ctrl-C, and the launcher then cannot stop its child. If `19975-19999` is busy, pick another span of at least four ports below `32768`, still outside `8799`, `18799`, and `28799`.

Ready is the one JSON object on stdout, and the process staying in the foreground:

```json
{"ok":true,"url":"http://127.0.0.1:PORT","pid":PID,"dataDir":"/tmp/openmausbot-verify-data-XXXX","logPath":"/tmp/openmausbot-verification-evidence/server-TIMESTAMP-PARENT.log"}
```

That line is printed only after `GET /api/health` returns `"app":"openmausbot"` and the single seeded bot has been renamed to `Fixture Starter`. A health check on its own is not the ready signal. Keep `url`, `pid`, `dataDir`, and `logPath`. The printed `pid` is the server child. The foreground process is the parent you interrupt later.

`FAKE_CLAUDE_MODE` (default `happy`) and other `FAKE_CLAUDE_*` variables in the parent environment are copied into the child, except `FAKE_CLAUDE_DUMP`, which the launcher always sets to `dataDir/fake-claude-dump.json`. Happy mode replies `hello from fake claude`. Nothing else from the parent shell or a logged-in engine CLI is passed in.

Stop that foreground process with Ctrl-C when the drive is done. See Cleanup.

## Doctor

Run this before every drive, and again whenever the fixture looks wrong. It is read-only: it fetches `/api/health`, checks the launch pid's fixture environment, and runs `doctor`. It does not send a message.

```sh
node .cursor/skills/verify-omb/helpers/doctor.mjs \
  --url http://127.0.0.1:PORT \
  --pid PID \
  --data-dir "$DATA_DIR"
```

Exit 0 prints JSON with `ok: true`, `version` equal to this checkout's `package.json` version, `availableEngines` containing `claude`, and `sessionKind` `loopback`. A warning that agent-browser is not installed is expected and still exits 0. Exit 1 means this instance is not worth driving.

`pnpm control:omb doctor --url URL` is the same verb. Prefer the helper. The pnpm script prints a package banner before the JSON.

## Drive

The harness is `control-omb`. Pass the launch URL on every verb. Stdout of the node invocation is one JSON document. Record each verb with the helper in Helpers so the proof is not stored in `dataDir`.

Create the bot the recipe names. `Fixture Starter` is only the seeded rename that marks the server ready.

```sh
EVIDENCE=/tmp/openmausbot-verification-evidence/runs/PID
node .cursor/skills/verify-omb/helpers/record.mjs \
  --evidence "$EVIDENCE" --name new-bot --data-dir "$DATA_DIR" -- \
  node --experimental-strip-types scripts/control-omb.ts new-bot --name Probe --url "$URL"
```

Read `bot.id` from `stdout` inside `new-bot.json`. Then send, wait, and read:

```sh
node .cursor/skills/verify-omb/helpers/record.mjs \
  --evidence "$EVIDENCE" --name send --data-dir "$DATA_DIR" -- \
  node --experimental-strip-types scripts/control-omb.ts send --bot "$BOT_ID" --text hello --url "$URL"

node .cursor/skills/verify-omb/helpers/record.mjs \
  --evidence "$EVIDENCE" --name wait --data-dir "$DATA_DIR" -- \
  node --experimental-strip-types scripts/control-omb.ts wait --bot "$BOT_ID" --timeout 30 --url "$URL"

node .cursor/skills/verify-omb/helpers/record.mjs \
  --evidence "$EVIDENCE" --name messages --data-dir "$DATA_DIR" -- \
  node --experimental-strip-types scripts/control-omb.ts messages --bot "$BOT_ID" --limit 10 --url "$URL"
```

Stable handles:

- Bot and channel ids come from `new-bot` (`bot.id`) and `new-channel` (`channel.id`).
- The selected task is `bot.activeTaskId`. Pass `--task THREAD_ID` only to aim at a different owned task.
- Renderer controls are accessible names. The composer for a bot named Pepper is the textbox `Message Pepper`. The transcript landmark is `log "Conversation with Pepper"`. `ui click` and `ui type` take `--name` or `--ref @eN` from `ui snapshot`. There is no coordinate drive.

`--dry-run` on `send` does not start a turn. A passing dry-run is not proof that a message was sent.

The renderer path is a second foreground process, not a second server you discover:

```sh
node --experimental-strip-types scripts/control-omb.ts ui launch
```

It prints `ui` (a `ui.json` path inside that launch's `dataDir`), `url`, `previewUrl`, and `botId` for the seeded bot Pepper. Pass that handle as `--ui` on every later `ui` verb. Recipes for each feature are under `features/`.

## Evidence

Proof artifacts live in `/tmp/openmausbot-verification-evidence/`. The server log is the printed `logPath`. Verb transcripts live in `/tmp/openmausbot-verification-evidence/runs/PID/`. Cleanup deletes `dataDir` only. Both of those evidence locations survive.

A proof shows the action and the resulting state:

- `send` exits 0 with `success: true` and a `messageId`.
- `wait` exits 0 with `status: "settled"`.
- `messages` contains a `role: "user"` text `hello` and, after it, a `role: "bot"` `kind: "text"` message whose text is `hello from fake claude`.

`wait` can report `state: "idle"` and `job.reason` `Nothing is running in this conversation` when the fake reply finishes before `wait` attaches. That is still a settled turn. The transcript is the proof, not `job.state`.

Before cleanup, record the engine side effect without copying the dump. The dump's `env` and `mcpConfig` stay in `dataDir`.

```sh
DATA="$DATA_DIR" EVIDENCE="$EVIDENCE" node --input-type=module -e '
import { readFileSync, writeFileSync } from "node:fs";
const dump = JSON.parse(readFileSync(`${process.env.DATA}/fake-claude-dump.json`, "utf8"));
const modelAt = dump.argv.indexOf("--model");
const proof = {
  model: dump.argv[modelAt + 1] ?? null,
  homeIsDataDir: dump.env?.HOME === process.env.DATA,
  promptHasHello: JSON.stringify(dump.prompt).includes("hello"),
};
if (proof.model !== "claude-sonnet-5" || !proof.homeIsDataDir || !proof.promptHasHello) {
  process.stderr.write(`${JSON.stringify(proof)}\n`);
  process.exit(1);
}
writeFileSync(`${process.env.EVIDENCE}/side-effect.json`, `${JSON.stringify(proof, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify(proof)}\n`);
'
```

Happy mode also appends a `Bash` activity and a digest line. Those are scripted provider events. They are not a shell that ran on the machine. Do not treat them as the user-visible reply.

Mocks stop at the fake engine the fixture already installs. Do not point a recipe at a live Claude, Codex, or Grok login. A dry-run that skips the send is not a substitute for the transcript above.

## Cleanup

Interrupt the foreground `launch` or `ui launch` process you started (Ctrl-C in its terminal). It SIGTERMs the printed server pid and deletes only that `dataDir`. Confirm:

- the `dataDir` path is gone
- the printed `logPath` still exists
- `/tmp/openmausbot-verification-evidence/runs/PID/` still contains `new-bot.json`, `send.json`, `wait.json`, `messages.json`, and `side-effect.json`
- the port is no longer accepting connections

Do not kill processes by name, do not delete `/tmp/openmausbot-verify-data-*` as a glob, and do not delete `/tmp/openmausbot-verification-evidence`.

## Helpers

Both scripts are executable. Invoke them with Node 24 from the repository root.

Read-only doctor, from Doctor:

```sh
node .cursor/skills/verify-omb/helpers/doctor.mjs --url "$URL" --pid "$PID" --data-dir "$DATA_DIR"
```

Record a verb's argv, stdout, stderr, and exit code outside the fixture, from Drive:

```sh
node .cursor/skills/verify-omb/helpers/record.mjs \
  --evidence "$EVIDENCE" --name send --data-dir "$DATA_DIR" -- \
  node --experimental-strip-types scripts/control-omb.ts send --bot "$BOT_ID" --text hello --url "$URL"
```

`--name` is lowercase words separated by hyphens. The helper exits with the recorded command's status and refuses an evidence directory inside `dataDir`.
