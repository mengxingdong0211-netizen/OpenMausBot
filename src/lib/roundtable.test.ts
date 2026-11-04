import { describe, expect, it } from "vitest";

import { groupComposerHint, groupResponseHint } from "./group-routing";
import { roundtableIdleHint, threadRoundtable } from "./roundtable";
import type { Group } from "@/state/store";
import type { WireRoundtable, WireRoundtablePhase, WireSeatPresence } from "../../shared/wire";

function table(phase: WireRoundtablePhase, seats: Array<{ botId: string; presence: WireSeatPresence }> = []): WireRoundtable {
  return {
    threadId: "thread",
    chairBotId: "ada",
    chairPresence: "idle",
    round: 1,
    rounds: 1,
    phase,
    seats,
  };
}

const names = (botId: string) => ({ ada: "Ada", kai: "Kai" }[botId] ?? botId);

describe("threadRoundtable", () => {
  it("returns the row for the open thread", () => {
    const open = table("awaiting-person");
    const other = { ...table("chair"), threadId: "other" };
    expect(threadRoundtable({ threadId: "thread", roundtables: [other, open] })).toBe(open);
  });

  it("can name a thread other than the one on screen", () => {
    const other = { ...table("seat"), threadId: "other" };
    expect(threadRoundtable({ threadId: "thread", roundtables: [other] }, "other")).toBe(other);
  });

  it("returns nothing when the open thread has no row", () => {
    expect(threadRoundtable({ threadId: "thread" })).toBeUndefined();
    expect(threadRoundtable({ threadId: "thread", roundtables: [] })).toBeUndefined();
    expect(threadRoundtable({ threadId: "thread", roundtables: [{ ...table("chair"), threadId: "other" }] })).toBeUndefined();
  });
});

describe("roundtableIdleHint", () => {
  it("names the chair, and the next seat while the table is waiting for the person", () => {
    expect(roundtableIdleHint(table("awaiting-person", [{ botId: "kai", presence: "up" }]), names)).toBe(
      "To Ada. Kai is next.",
    );
    expect(roundtableIdleHint(table("awaiting-person", [{ botId: "kai", presence: "waiting" }]), names)).toBe("To Ada");
  });

  it("stays on the chair for every other phase, including a released seat", () => {
    const released = [{ botId: "kai", presence: "up" as const }];
    expect(roundtableIdleHint(table("chair", released), names)).toBe("To Ada");
    expect(roundtableIdleHint(table("seat", released), names)).toBe("To Ada");
    expect(roundtableIdleHint(table("adjourning", released), names)).toBe("To Ada");
  });
});

describe("room idle hints", () => {
  const members = [
    { id: "ada", name: "Ada" },
    { id: "kai", name: "Kai" },
  ] as Parameters<typeof groupComposerHint>[1];

  const room = (roundtables?: WireRoundtable[]) => ({
    threadId: "thread",
    dm: false,
    defaultResponder: { kind: "everyone" },
    roundtables,
  }) as Group;

  it("uses the roundtable hint on the open thread and leaves other rooms alone", () => {
    const open = table("awaiting-person", [{ botId: "kai", presence: "up" }]);
    expect(groupComposerHint(room([open]), members)).toBe("To Ada. Kai is next.");
    expect(groupResponseHint(room([open]), members)).toBe("To Ada. Kai is next.");
    expect(groupComposerHint(room([]), members)).toBe("everyone responds");
    expect(groupComposerHint(room([{ ...open, threadId: "other" }]), members)).toBe("everyone responds");
    expect(groupResponseHint({ dm: true } as Group, members)).toBe("Reply here to continue the bot-to-bot conversation.");
  });
});
