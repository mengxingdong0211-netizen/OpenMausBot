import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { launchVerificationServer, runControlOmb } from "../scripts/control-omb.ts";

async function launch() {
  const fixture = await launchVerificationServer({}, undefined, undefined, undefined, undefined, { scripted: true });
  const { url, dataDir } = fixture.info;
  const raw = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, body: await response.json() as any };
  };
  const planPath = join(dataDir, "room-plan.json");
  const api = async (method: string, path: string, body?: unknown, expectedStatus = 200) => {
    const response = await fetch(url + path, {
      method,
      headers: { "content-type": "application/json", origin: url },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value = await response.json() as any;
    expect(response.status, `${method} ${path}: ${JSON.stringify(value)}`).toBe(expectedStatus);
    return value;
  };
  const control = (args: string[]) => runControlOmb([...args, "--url", url]) as Promise<any>;
  const plan = (turns: Record<string, unknown>) => writeFileSync(planPath, JSON.stringify(turns));
  const roomState = async (groupId: string) => {
    const state = await api("GET", "/api/bots?messages=40");
    const group = state.groups.find((candidate: { id: string }) => candidate.id === groupId);
    const messages = (group?.messages ?? []) as Array<{ kind?: string; role?: string; text?: string; from?: { name?: string } }>;
    return {
      working: Boolean(group?.working),
      roundtables: group?.roundtables ?? null,
      speakers: messages.filter((message) => message.kind === "text" && message.role === "bot").map((message) => message.from?.name),
      texts: messages.filter((message) => message.kind === "text" && message.role === "bot").map((message) => message.text),
      goal: messages.some((message) => message.kind === "goal.run"),
    };
  };
  const settled = (groupId: string, speakers: string[]) => expect.poll(async () => {
    const state = await roomState(groupId);
    return state.working ? null : state.speakers;
  }, { timeout: 60_000 }).toEqual(speakers);
  return { api, raw, control, plan, roomState, settled, close: () => fixture.close() };
}

it("lets an ordinary room speak without a session", async () => {
  const { api, control, plan, roomState, settled, close } = await launch();
  try {
    const ada = (await control(["new-bot", "--name", "Ada"])).bot;
    const scout = (await control(["new-bot", "--name", "Scout"])).bot;
    plan({
      [ada.id]: { turns: [{ reply: "Ada is here." }] },
      [scout.id]: { turns: [{ reply: "Scout is here." }] },
    });
    const room = (await api("POST", "/api/groups", {
      name: "Ordinary room",
      memberIds: [ada.id, scout.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    }, 201)).group;
    expect(room.roundtables).toEqual([]);

    await api("POST", `/api/groups/${room.id}/messages`, { text: "Hello both of you.", sendId: "ordinary_send_01" }, 202);
    await settled(room.id, ["Ada", "Scout"]);
    expect((await roomState(room.id)).roundtables).toEqual([]);
  } finally {
    await close();
  }
}, 150_000);

it("wakes only the chair until the chair advances a seat, and refuses a goal", async () => {
  const { api, raw, control, plan, roomState, settled, close } = await launch();
  try {
    const ada = (await control(["new-bot", "--name", "Ada"])).bot;
    const scout = (await control(["new-bot", "--name", "Scout"])).bot;
    plan({
      [ada.id]: {
        turns: [
          { reply: "The chair has the floor." },
          { reply: "Scout, go ahead.", steps: [{ tool: "grant_seat", arguments: { decision: "advance" } }] },
          { reply: "Noted." },
        ],
      },
      [scout.id]: { turns: [{ reply: "The seat's report." }] },
    });
    const room = (await api("POST", "/api/groups", {
      name: "Roundtable room",
      memberIds: [ada.id, scout.id],
      setup: { bulletin: "", defaultResponder: { kind: "everyone" } },
    }, 201)).group;
    const opened = await api("POST", `/api/groups/${room.id}/roundtable`, {
      threadId: room.threadId,
      chairBotId: ada.id,
      seats: [scout.id],
      rounds: 1,
    }, 201);
    expect(opened.roundtable).toMatchObject({
      threadId: room.threadId,
      chairBotId: ada.id,
      phase: "awaiting-person",
      seats: [{ botId: scout.id }],
    });
    expect((await roomState(room.id)).roundtables).toEqual([expect.objectContaining({
      threadId: room.threadId,
      chairBotId: ada.id,
      phase: "awaiting-person",
    })]);

    await api("POST", `/api/groups/${room.id}/messages`, { text: "Open the meeting.", sendId: "roundtable_send_01" }, 202);
    await settled(room.id, ["Ada"]);
    expect((await roomState(room.id)).texts).toEqual(["The chair has the floor."]);

    await api("POST", `/api/groups/${room.id}/messages`, { text: "Ask for the report.", sendId: "roundtable_send_02" }, 202);
    await settled(room.id, ["Ada", "Ada", "Scout", "Ada"]);
    expect((await roomState(room.id)).texts).toEqual([
      "The chair has the floor.",
      "Scout, go ahead.",
      "The seat's report.",
      "Noted.",
    ]);

    const refused = await raw("POST", `/api/groups/${room.id}/messages`, { text: "Finish the launch draft.", mode: "goal", sendId: "roundtable_goal_01" });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("a roundtable is in session on this thread");
    const after = await roomState(room.id);
    expect(after.goal).toBe(false);
    expect(after.texts).toEqual([
      "The chair has the floor.",
      "Scout, go ahead.",
      "The seat's report.",
      "Noted.",
    ]);
    expect(after.roundtables).toEqual([expect.objectContaining({ phase: "awaiting-person", chairBotId: ada.id })]);
  } finally {
    await close();
  }
}, 150_000);
