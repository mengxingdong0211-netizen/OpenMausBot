import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  createRoundtableTable,
  type GrantHandler,
  type RoundtableGroupView,
  type RoundtableMemberResult,
  type RoundtableMemberTurn,
  type RoundtableTable,
  type ThreadPending,
} from "./roundtable.ts";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Member {
  id: string;
  name: string;
  hidden?: boolean;
}

interface Harness {
  dataDir: string;
  table: RoundtableTable;
  grant: GrantHandler;
  members: Member[];
  held: Set<string>;
  pending: ThreadPending;
  notes: string[];
  changed: string[];
  cancelled: string[];
  leadBotId: string | null;
  threadIds: string[];
  dm: boolean;
  setupPending: boolean;
}

function harness(options?: { dataDir?: string; members?: Member[] }): Harness {
  const dataDir = options?.dataDir ?? mkdtempSync(join(tmpdir(), "omb-roundtable-"));
  dirs.push(dataDir);
  const fx = {
    dataDir,
    members: options?.members ?? [
      { id: "cleo", name: "Cleo" },
      { id: "scout", name: "Scout" },
      { id: "pepper", name: "Pepper" },
    ],
    held: new Set<string>(),
    pending: "ready" as ThreadPending,
    notes: [] as string[],
    changed: [] as string[],
    cancelled: [] as string[],
    leadBotId: "cleo" as string | null,
    threadIds: ["talk", "side", "lane"],
    dm: false,
    setupPending: false,
  };
  let grant: GrantHandler | undefined;
  const table = createRoundtableTable({
    dataDir,
    now: () => 1_700_000_000_000,
    group: (groupId): RoundtableGroupView | undefined => groupId === "room" ? {
      id: groupId,
      dm: fx.dm,
      setupPending: fx.setupPending,
      threadIds: fx.threadIds,
      members: fx.members,
      leadBotId: fx.leadBotId,
    } : undefined,
    held: (_groupId, botId) => fx.held.has(botId),
    pending: () => fx.pending,
    onChanged: (groupId) => { fx.changed.push(groupId); },
    cancelThread: (threadId) => { fx.cancelled.push(threadId); },
    note: (_threadId, text) => { fx.notes.push(text); },
    registerGrantTool: (handler) => { grant = handler; },
  });
  if (!grant) throw new Error("grant tool was not registered");
  return Object.assign(fx, { table, grant });
}

function agenda(dataDir: string): { version: number; sessions: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(join(dataDir, "roundtables.json"), "utf8")) as {
    version: number;
    sessions: Array<Record<string, unknown>>;
  };
}

function writeAgenda(dataDir: string, sessions: unknown[], version: unknown = 1): void {
  writeFileSync(join(dataDir, "roundtables.json"), JSON.stringify({ version, sessions }));
}

interface Step {
  decision?: "advance" | "skip" | "yield" | "adjourn";
  decisions?: Array<"advance" | "skip" | "yield" | "adjourn">;
  outcome?: RoundtableMemberResult["outcome"];
  waiting?: boolean;
  at?: (turn: RoundtableMemberTurn) => void;
}

async function runScript(
  fx: Harness,
  steps: Step[],
  options?: { operationId?: string; threadId?: string; cancelled?: () => boolean },
): Promise<RoundtableMemberTurn[]> {
  const seen: RoundtableMemberTurn[] = [];
  let waiting = false;
  const threadId = options?.threadId ?? "talk";
  await fx.table.run({
    operationId: options?.operationId ?? "op-1",
    groupId: "room",
    threadId,
    cancelled: () => options?.cancelled?.() ?? false,
    humanWaiting: () => waiting,
    runMember: async (turn) => {
      const step = steps[seen.length];
      if (!step) throw new Error(`unexpected ${turn.role} turn for ${turn.botId}`);
      seen.push(turn);
      step.at?.(turn);
      const decisions = step.decisions ?? (step.decision ? [step.decision] : []);
      for (const decision of decisions) fx.grant({ threadId, botId: turn.botId, decision });
      waiting = step.waiting ?? false;
      return { outcome: step.outcome ?? "settled" };
    },
  });
  return seen;
}

describe("roundtable", () => {
  it("opens on the lead and the other active members", () => {
    const fx = harness({
      members: [
        { id: "old", name: "Old", hidden: true },
        { id: "cleo", name: "Cleo" },
        { id: "scout", name: "Scout" },
        { id: "pepper", name: "Pepper" },
      ],
    });
    const opened = fx.table.open("room", "talk", {});
    expect(opened).toEqual({
      threadId: "talk",
      chairBotId: "cleo",
      chairPresence: "idle",
      round: 1,
      rounds: 1,
      phase: "awaiting-person",
      seats: [
        { botId: "scout", presence: "up" },
        { botId: "pepper", presence: "waiting" },
      ],
    });
    expect(fx.changed).toEqual(["room"]);
    const stored = agenda(fx.dataDir);
    expect(stored.version).toBe(1);
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0]).toMatchObject({
      groupId: "room",
      threadId: "talk",
      chairBotId: "cleo",
      round: 1,
      rounds: 1,
      seats: [
        { botId: "scout", state: "pending" },
        { botId: "pepper", state: "pending" },
      ],
    });
    expect(stored.sessions[0]).not.toHaveProperty("phase");
    expect(stored.sessions[0]).not.toHaveProperty("grant");
    expect(statSync(join(fx.dataDir, "roundtables.json")).mode & 0o777).toBe(0o600);
    expect(fx.table.live("talk")).toBe(true);
    expect(fx.table.live("lane")).toBe(false);
  });

  it("uses an explicit chair, seat order, and round count", () => {
    const fx = harness();
    fx.leadBotId = null;
    const opened = fx.table.open("room", "talk", {
      threadId: "talk",
      chairBotId: "pepper",
      seats: ["scout", "cleo"],
      rounds: 3,
    });
    expect(opened.chairBotId).toBe("pepper");
    expect(opened.rounds).toBe(3);
    expect(opened.seats.map((seat) => seat.botId)).toEqual(["scout", "cleo"]);
  });

  it("uses the first active member when the lead is missing or hidden", () => {
    const fx = harness({
      members: [
        { id: "old", name: "Old", hidden: true },
        { id: "scout", name: "Scout" },
        { id: "pepper", name: "Pepper" },
      ],
    });
    fx.leadBotId = "old";
    expect(fx.table.open("room", "talk", {}).chairBotId).toBe("scout");
    expect(fx.table.project("room", () => undefined)[0]?.seats.map((seat) => seat.botId)).toEqual(["pepper"]);
  });

  it("rejects a room or body that cannot open", () => {
    const fx = harness();
    fx.dm = true;
    expect(() => fx.table.open("room", "talk", {})).toThrow(expect.objectContaining({ status: 400 }));
    fx.dm = false;
    fx.setupPending = true;
    expect(() => fx.table.open("room", "talk", {})).toThrow(expect.objectContaining({ status: 409 }));
    fx.setupPending = false;
    expect(() => fx.table.open("missing", "talk", {})).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => fx.table.open("room", "elsewhere", {})).toThrow(expect.objectContaining({ status: 404 }));
    fx.pending = "working";
    expect(() => fx.table.open("room", "talk", {})).toThrow(expect.objectContaining({ status: 409 }));
    fx.pending = "goal";
    expect(() => fx.table.open("room", "talk", {})).toThrow(expect.objectContaining({ status: 409 }));
    fx.pending = "ready";
    expect(() => fx.table.open("room", "talk", [])).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => fx.table.open("room", "talk", { extra: true })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => fx.table.open("room", "talk", { threadId: "side" })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => fx.table.open("room", "talk", { rounds: 4 })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => fx.table.open("room", "talk", { seats: [] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => fx.table.open("room", "talk", { seats: ["scout", "scout"] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => fx.table.open("room", "talk", { seats: ["cleo"] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => fx.table.open("room", "talk", { seats: ["old"] })).toThrow(expect.objectContaining({ status: 400 }));
    expect(() => fx.table.open("room", "talk", { chairBotId: "nobody" })).toThrow(expect.objectContaining({ status: 400 }));
    fx.members = [{ id: "cleo", name: "Cleo" }];
    expect(() => fx.table.open("room", "talk", {})).toThrow(expect.objectContaining({ status: 400 }));
    fx.members = [
      { id: "cleo", name: "Cleo" },
      { id: "scout", name: "Scout" },
    ];
    fx.table.open("room", "talk", {});
    expect(() => fx.table.open("room", "talk", {})).toThrow(expect.objectContaining({ status: 409 }));
    expect(agenda(fx.dataDir).sessions).toHaveLength(1);
  });

  it("applies a grant recorded during the chair turn and then releases the chair", async () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    const turns = await runScript(fx, [
      {
        at: (turn) => {
          expect(turn.role).toBe("chair");
          expect(turn.instructions).toContain("Scout");
          expect(turn.instructions).toContain("grant_seat");
          expect(fx.grant({ threadId: "talk", botId: "scout", decision: "advance" })).toEqual({
            ok: false,
            error: "only the released chair can grant a seat",
          });
          expect(fx.grant({ threadId: "talk", botId: "cleo", decision: { decision: "advance" } })).toEqual({
            ok: false,
            error: "decision must be advance, skip, yield, or adjourn",
          });
        },
        decision: "advance",
      },
      {
        at: (turn) => {
          expect(turn.role).toBe("seat");
          expect(turn.botId).toBe("scout");
          expect(turn.instructions).toContain("Cleo");
          expect(turn.instructions).toContain("Do not call grant_seat.");
          const stored = agenda(fx.dataDir).sessions[0];
          expect(stored?.seats).toEqual([
            { botId: "scout", state: "pending" },
            { botId: "pepper", state: "pending" },
          ]);
          expect(stored).not.toHaveProperty("grant");
        },
      },
      { decision: "yield" },
    ]);
    expect(turns.map((turn) => [turn.role, turn.botId])).toEqual([
      ["chair", "cleo"],
      ["seat", "scout"],
      ["chair", "cleo"],
    ]);
    expect(fx.table.project("room", () => undefined)[0]).toMatchObject({
      phase: "awaiting-person",
      seats: [
        { botId: "scout", presence: "done" },
        { botId: "pepper", presence: "up" },
      ],
    });
    expect(fx.grant({ threadId: "talk", botId: "cleo", decision: "advance" })).toMatchObject({ ok: false });
  });

  it("keeps the last grant when the chair records two in one turn", async () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    const turns = await runScript(fx, [{ decisions: ["advance", "yield"] }]);
    expect(turns.map((turn) => turn.role)).toEqual(["chair"]);
    expect(agenda(fx.dataDir).sessions[0]?.seats).toEqual([
      { botId: "scout", state: "pending" },
      { botId: "pepper", state: "pending" },
    ]);
    expect(fx.table.project("room", () => undefined)[0]?.phase).toBe("awaiting-person");
  });

  it("stops advance on a held seat", async () => {
    const fx = harness();
    fx.held.add("scout");
    fx.table.open("room", "talk", {});
    expect(fx.table.project("room", () => undefined)[0]?.seats).toEqual([
      { botId: "scout", presence: "held" },
      { botId: "pepper", presence: "waiting" },
    ]);
    const turns = await runScript(fx, [{ decision: "advance" }]);
    expect(turns.map((turn) => turn.botId)).toEqual(["cleo"]);
    expect(agenda(fx.dataDir).sessions[0]?.seats).toEqual([
      { botId: "scout", state: "pending" },
      { botId: "pepper", state: "pending" },
    ]);
    expect(fx.table.live("talk")).toBe(true);
    expect(fx.table.project("room", () => undefined)[0]?.phase).toBe("awaiting-person");
  });

  it("skips a held seat and calls the next one", async () => {
    const fx = harness();
    fx.held.add("scout");
    fx.table.open("room", "talk", {});
    const turns = await runScript(fx, [
      { decision: "skip" },
      {
        at: () => {
          expect(agenda(fx.dataDir).sessions[0]?.seats).toEqual([
            { botId: "scout", state: "skipped" },
            { botId: "pepper", state: "pending" },
          ]);
        },
      },
      { decision: "yield" },
    ]);
    expect(turns.map((turn) => [turn.role, turn.botId])).toEqual([
      ["chair", "cleo"],
      ["seat", "pepper"],
      ["chair", "cleo"],
    ]);
    expect(fx.table.project("room", () => undefined)[0]?.seats).toEqual([
      { botId: "scout", presence: "skipped" },
      { botId: "pepper", presence: "done" },
    ]);
  });

  it("skips a member who left when the chair advances onto them", async () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    fx.members = fx.members.map((member) => member.id === "scout" ? { ...member, hidden: true } : member);
    const turns = await runScript(fx, [
      { decision: "advance" },
      {},
      { decision: "yield" },
    ]);
    expect(turns.map((turn) => turn.botId)).toEqual(["cleo", "pepper", "cleo"]);
    expect(agenda(fx.dataDir).sessions[0]?.seats).toEqual([
      { botId: "scout", state: "skipped" },
      { botId: "pepper", state: "done" },
    ]);
  });

  it("keeps the agenda when the chair yields and the operation ends", async () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    await runScript(fx, [{ decision: "yield" }]);
    fx.table.operationEnded("talk", "op-1");
    expect(fx.table.live("talk")).toBe(true);
    expect(agenda(fx.dataDir).sessions).toHaveLength(1);
    expect(fx.table.project("room", () => undefined)[0]).toMatchObject({
      phase: "awaiting-person",
      round: 1,
      seats: [
        { botId: "scout", presence: "up" },
        { botId: "pepper", presence: "waiting" },
      ],
    });
    expect(fx.cancelled).toEqual([]);
  });

  it("deletes an idle agenda on adjourn", () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    fx.table.adjourn("room", "talk");
    expect(fx.table.live("talk")).toBe(false);
    expect(fx.table.project("room", () => undefined)).toEqual([]);
    expect(agenda(fx.dataDir).sessions).toEqual([]);
    expect(fx.cancelled).toEqual([]);
    fx.table.adjourn("room", "talk");
    expect(agenda(fx.dataDir).sessions).toEqual([]);
  });

  it("deletes on operationEnded only after adjourn, and only for that operation", async () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    const turns = await runScript(fx, [{
      at: () => {
        expect(fx.grant({ threadId: "talk", botId: "cleo", decision: "advance" })).toEqual({ ok: true });
        fx.table.adjourn("room", "talk");
      },
    }]);
    expect(turns.map((turn) => turn.role)).toEqual(["chair"]);
    expect(fx.table.live("talk")).toBe(false);
    expect(fx.cancelled).toEqual(["talk"]);
    expect(fx.table.project("room", () => undefined)[0]?.phase).toBe("adjourning");
    expect(agenda(fx.dataDir).sessions).toHaveLength(1);
    fx.table.operationEnded("talk", "other-op");
    expect(agenda(fx.dataDir).sessions).toHaveLength(1);
    fx.table.operationEnded("talk", "op-1");
    expect(fx.table.live("talk")).toBe(false);
    expect(fx.table.project("room", () => undefined)).toEqual([]);
    expect(agenda(fx.dataDir).sessions).toEqual([]);
  });

  it("adjourns a session whose operation has not entered run yet", () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    fx.pending = "working";
    fx.table.adjourn("room", "talk");
    expect(fx.table.live("talk")).toBe(false);
    expect(fx.cancelled).toEqual(["talk"]);
    expect(agenda(fx.dataDir).sessions).toHaveLength(1);
    expect(fx.table.project("room", () => undefined)[0]?.phase).toBe("adjourning");
    fx.table.operationEnded("talk", "op-later");
    expect(agenda(fx.dataDir).sessions).toEqual([]);
    expect(fx.table.live("talk")).toBe(false);
  });

  it("queues every coordinator bot and refuses a member turn that was not released", async () => {
    const fx = harness();
    expect(fx.table.admit("talk", "cleo", "coordinator")).toBe("allow");
    expect(fx.table.admit("talk", "scout", "member-turn")).toBe("allow");
    fx.table.open("room", "talk", {});
    for (const botId of ["cleo", "scout", "pepper", "stranger"]) {
      expect(fx.table.admit("talk", botId, "coordinator")).toBe("queue");
      expect(fx.table.admit("talk", botId, "member-turn")).toBe("refuse");
    }
    expect(fx.table.admit("lane", "cleo", "coordinator")).toBe("allow");
    expect(fx.table.admit("lane", "cleo", "member-turn")).toBe("allow");

    await runScript(fx, [
      {
        decision: "advance",
        at: () => {
          expect(fx.table.admit("talk", "cleo", "member-turn")).toBe("allow");
          expect(fx.table.admit("talk", "cleo", "coordinator")).toBe("queue");
          expect(fx.table.admit("talk", "scout", "member-turn")).toBe("refuse");
        },
      },
      {
        at: () => {
          expect(fx.table.admit("talk", "scout", "member-turn")).toBe("allow");
          expect(fx.table.admit("talk", "cleo", "member-turn")).toBe("refuse");
          expect(fx.table.admit("talk", "scout", "coordinator")).toBe("queue");
        },
      },
      { decision: "yield" },
    ]);
  });

  it("projects speaking from the confirmed speaker and up from a release", async () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    let speaker: string | undefined;
    const faces = () => fx.table.project("room", () => speaker)[0];
    await runScript(fx, [
      {
        decision: "advance",
        at: () => {
          expect(faces()).toMatchObject({
            phase: "chair",
            chairPresence: "up",
            seats: [
              { botId: "scout", presence: "up" },
              { botId: "pepper", presence: "waiting" },
            ],
          });
          speaker = "cleo";
          expect(faces()?.chairPresence).toBe("speaking");
          expect(faces()?.seats[0]?.presence).toBe("up");
          speaker = undefined;
        },
      },
      {
        at: () => {
          expect(faces()).toMatchObject({
            phase: "seat",
            chairPresence: "idle",
            seats: [
              { botId: "scout", presence: "up" },
              { botId: "pepper", presence: "waiting" },
            ],
          });
          speaker = "scout";
          const claimed = faces();
          expect(claimed?.seats[0]?.presence).toBe("speaking");
          expect(claimed?.chairPresence).toBe("idle");
          expect(claimed?.seats[0]?.presence).not.toBe("up");
        },
      },
      { decision: "yield" },
    ]);
  });

  it("loads a saved agenda as awaiting-person and drops an in-flight grant", () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-roundtable-"));
    dirs.push(dataDir);
    writeAgenda(dataDir, [{
      id: "rt-1",
      groupId: "room",
      threadId: "talk",
      chairBotId: "cleo",
      seats: [
        { botId: "scout", state: "done" },
        { botId: "pepper", state: "pending" },
      ],
      round: 2,
      rounds: 3,
      phase: "seat",
      grant: "advance",
      operationId: "old-op",
    }]);
    const fx = harness({ dataDir });
    expect(fx.table.live("talk")).toBe(true);
    const view = fx.table.project("room", () => undefined)[0];
    expect(view).toMatchObject({
      phase: "awaiting-person",
      round: 2,
      rounds: 3,
      chairPresence: "idle",
      seats: [
        { botId: "scout", presence: "done" },
        { botId: "pepper", presence: "up" },
      ],
    });
    expect(fx.grant({ threadId: "talk", botId: "cleo", decision: "advance" })).toMatchObject({ ok: false });
  });

  it("refuses a present invalid agenda and skips a row that names no thread", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-roundtable-"));
    dirs.push(dataDir);
    const body = JSON.stringify({
      version: 1,
      sessions: [
        { groupId: "room", threadId: "talk", chairBotId: "cleo", seats: "broken", round: 1, rounds: 1 },
        { seats: [] },
        {
          id: "side-1",
          groupId: "room",
          threadId: "side",
          chairBotId: "cleo",
          seats: [{ botId: "scout", state: "pending" }],
          round: 1,
          rounds: 1,
        },
      ],
    });
    writeFileSync(join(dataDir, "roundtables.json"), body);
    const fx = harness({ dataDir });
    expect(readFileSync(join(dataDir, "roundtables.json"), "utf8")).toBe(body);
    expect(fx.table.live("talk")).toBe(true);
    expect(fx.table.live("lane")).toBe(false);
    expect(fx.table.live("side")).toBe(true);
    const turns: RoundtableMemberTurn[] = [];
    await expect(fx.table.run({
      operationId: "op-1",
      groupId: "room",
      threadId: "talk",
      cancelled: () => false,
      humanWaiting: () => false,
      runMember: async (turn) => {
        turns.push(turn);
        return { outcome: "settled" };
      },
    })).rejects.toMatchObject({ status: 409 });
    expect(turns).toEqual([]);
    expect(fx.table.admit("talk", "cleo", "coordinator")).toBe("queue");
    expect(fx.table.admit("talk", "scout", "member-turn")).toBe("refuse");
    expect(fx.table.admit("lane", "cleo", "member-turn")).toBe("allow");
    await expect(fx.table.run({
      operationId: "op-2",
      groupId: "room",
      threadId: "lane",
      cancelled: () => false,
      humanWaiting: () => false,
      runMember: async (turn) => {
        turns.push(turn);
        return { outcome: "settled" };
      },
    })).resolves.toBeUndefined();
    expect(turns).toEqual([]);
    fx.table.open("room", "lane", { seats: ["scout", "pepper"] });
    expect(fx.table.live("talk")).toBe(true);
    await expect(fx.table.run({
      operationId: "op-3",
      groupId: "room",
      threadId: "talk",
      cancelled: () => false,
      humanWaiting: () => false,
      runMember: async () => ({ outcome: "settled" }),
    })).rejects.toMatchObject({ status: 409 });
    fx.table.adjourn("room", "talk");
    expect(fx.table.live("talk")).toBe(false);
    expect(agenda(dataDir).sessions.map((session) => session.threadId).sort()).toEqual(["lane", "side"]);
  });

  it("skips a file whose version is not 1", async () => {
    const dataDir = mkdtempSync(join(tmpdir(), "omb-roundtable-"));
    dirs.push(dataDir);
    writeAgenda(dataDir, [{
      id: "rt-1",
      groupId: "room",
      threadId: "talk",
      chairBotId: "cleo",
      seats: [{ botId: "scout", state: "pending" }],
      round: 1,
      rounds: 1,
    }], 2);
    const fx = harness({ dataDir });
    expect(fx.table.live("talk")).toBe(false);
    const turns: RoundtableMemberTurn[] = [];
    await fx.table.run({
      operationId: "op-1",
      groupId: "room",
      threadId: "talk",
      cancelled: () => false,
      humanWaiting: () => false,
      runMember: async (turn) => {
        turns.push(turn);
        return { outcome: "settled" };
      },
    });
    expect(turns).toEqual([]);
  });

  it("returns the floor to the person after the second missed seat", async () => {
    const fx = harness();
    fx.table.open("room", "talk", { seats: ["scout"] });
    const turns = await runScript(fx, [
      { decision: "advance" },
      { outcome: "unavailable" },
      {
        decision: "advance",
        at: (turn) => {
          expect(turn.instructions).toContain("Scout");
          expect(turn.instructions).toContain("still pending");
        },
      },
      { outcome: "failed" },
    ]);
    expect(turns.map((turn) => [turn.role, turn.botId])).toEqual([
      ["chair", "cleo"],
      ["seat", "scout"],
      ["chair", "cleo"],
      ["seat", "scout"],
    ]);
    expect(fx.table.project("room", () => undefined)[0]).toMatchObject({
      phase: "awaiting-person",
      seats: [{ botId: "scout", presence: "up" }],
    });
    expect(agenda(fx.dataDir).sessions[0]?.seats).toEqual([{ botId: "scout", state: "pending" }]);
  });

  it("starts the next round when the chair advances past the last seat", async () => {
    const fx = harness();
    fx.table.open("room", "talk", { seats: ["scout"], rounds: 2 });
    const turns = await runScript(fx, [
      { decision: "advance" },
      {},
      { decision: "advance" },
      {
        at: () => {
          expect(fx.table.project("room", () => undefined)[0]).toMatchObject({
            round: 2,
            phase: "seat",
            seats: [{ botId: "scout", presence: "up" }],
          });
        },
      },
      { decision: "advance" },
    ]);
    expect(turns.map((turn) => [turn.role, turn.botId])).toEqual([
      ["chair", "cleo"],
      ["seat", "scout"],
      ["chair", "cleo"],
      ["seat", "scout"],
      ["chair", "cleo"],
    ]);
    expect(fx.table.project("room", () => undefined)[0]).toMatchObject({
      phase: "awaiting-person",
      round: 2,
      seats: [{ botId: "scout", presence: "done" }],
    });
  });

  it("drops back to the person when a line is already waiting", async () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    const afterChair = await runScript(fx, [{ decision: "advance", waiting: true }]);
    expect(afterChair.map((turn) => turn.role)).toEqual(["chair"]);
    expect(agenda(fx.dataDir).sessions[0]?.seats).toEqual([
      { botId: "scout", state: "pending" },
      { botId: "pepper", state: "pending" },
    ]);

    const afterSeat = await runScript(fx, [
      { decision: "advance" },
      { waiting: true },
    ]);
    expect(afterSeat.map((turn) => [turn.role, turn.botId])).toEqual([
      ["chair", "cleo"],
      ["seat", "scout"],
    ]);
    expect(fx.table.project("room", () => undefined)[0]).toMatchObject({
      phase: "awaiting-person",
      seats: [
        { botId: "scout", presence: "done" },
        { botId: "pepper", presence: "up" },
      ],
    });
  });

  it("ends the session when the chair has left", async () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    const turns = await runScript(fx, [{
      decision: "advance",
      at: () => {
        fx.members = fx.members.filter((member) => member.id !== "cleo");
      },
    }]);
    expect(turns).toHaveLength(1);
    expect(fx.table.live("talk")).toBe(false);
    expect(agenda(fx.dataDir).sessions).toEqual([]);
    expect(fx.notes).toEqual(["The chair left the room, so the roundtable ended."]);
  });

  it("does not mark the open seat done when the turn is cancelled", async () => {
    const fx = harness();
    fx.table.open("room", "talk", {});
    let cancel = false;
    const turns = await runScript(fx, [
      { decision: "advance" },
      {
        outcome: "cancelled",
        at: () => { cancel = true; },
      },
    ], { cancelled: () => cancel });
    expect(turns.map((turn) => turn.role)).toEqual(["chair", "seat"]);
    expect(agenda(fx.dataDir).sessions[0]?.seats).toEqual([
      { botId: "scout", state: "pending" },
      { botId: "pepper", state: "pending" },
    ]);
    expect(fx.table.project("room", () => undefined)[0]?.phase).toBe("awaiting-person");
  });
});
