import { Children, isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { RoundtableStrip } from "./RoundtableStrip";
import type { Group } from "@/state/store";
import type { MausColor, WireRoundtable } from "../../shared/wire";

const members = [
  { id: "ada", name: "Ada", color: "blue" as MausColor },
  { id: "kai", name: "Kai", color: "orange" as MausColor },
  { id: "pepper", name: "Pepper", color: "green" as MausColor },
];

function room(roundtables?: WireRoundtable[], queue?: Group["queue"]): Group {
  return {
    id: "room",
    threadId: "thread",
    name: "Planning",
    memberIds: members.map((member) => member.id),
    defaultResponder: { kind: "mentions" },
    bulletin: "",
    unread: false,
    createdAt: 1,
    messages: [],
    roundtables,
    queue,
  } as Group;
}

function table(): WireRoundtable {
  return {
    threadId: "thread",
    chairBotId: "ada",
    chairPresence: "speaking",
    round: 2,
    rounds: 3,
    phase: "chair",
    seats: [
      { botId: "kai", presence: "up" },
      { botId: "pepper", presence: "waiting" },
    ],
  };
}

function markup(node: ReactNode): string {
  return isValidElement(node) ? renderToStaticMarkup(node) : "";
}

function cells(html: string): Record<string, string> {
  const marks = [...html.matchAll(/data-roundtable-member="([^"]+)"/g)];
  const found: Record<string, string> = {};
  marks.forEach((mark, index) => {
    const start = mark.index ?? 0;
    const end = marks[index + 1]?.index ?? html.length;
    const id = mark[1];
    if (id) found[id] = html.slice(start, end);
  });
  return found;
}

function click(node: ReactNode, testId: string): void {
  const walk = (current: ReactNode): boolean => {
    if (!isValidElement(current)) return false;
    const props = current.props as { onClick?: () => void; "data-testid"?: string; children?: ReactNode };
    if (props["data-testid"] === testId) {
      props.onClick?.();
      return true;
    }
    let hit = false;
    Children.forEach(props.children, (child) => {
      hit = walk(child) || hit;
    });
    return hit;
  };
  if (!walk(node)) throw new Error(`no ${testId} control`);
}

describe("RoundtableStrip", () => {
  it("offers open only when the thread has no row, the room has two members, and this client can host", () => {
    const onOpen = vi.fn();
    const closed = RoundtableStrip({ group: room(), members, remoteClient: false, onOpen, onAdjourn: vi.fn() });
    expect(markup(closed)).toContain("data-testid=\"roundtable-open\"");
    expect(markup(closed)).not.toContain("data-testid=\"roundtable-adjourn\"");
    click(closed, "roundtable-open");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledWith({ threadId: "thread" });

    expect(markup(RoundtableStrip({
      group: room(),
      members: members.slice(0, 1),
      remoteClient: false,
      onOpen,
      onAdjourn: vi.fn(),
    }))).toBe("");
    expect(markup(RoundtableStrip({ group: room(), members, remoteClient: true, onOpen, onAdjourn: vi.fn() }))).toBe("");
  });

  it("paints the chair and seats from the roundtable, with a live pill only for the confirmed speaker", () => {
    const onAdjourn = vi.fn();
    const node = RoundtableStrip({
      group: room([table()], [{ botId: "pepper", threadId: "thread", state: "running", position: 1, of: 1 }]),
      members,
      remoteClient: false,
      onOpen: vi.fn(),
      onAdjourn,
    });
    const html = markup(node);
    const painted = cells(html);
    expect(html.indexOf('data-roundtable-member="ada"')).toBeLessThan(html.indexOf('data-roundtable-member="kai"'));
    expect(html.indexOf('data-roundtable-member="kai"')).toBeLessThan(html.indexOf('data-roundtable-member="pepper"'));
    expect(painted.ada).toContain('data-presence="speaking"');
    expect(painted.ada).toContain("data-live-pill");
    expect(painted.ada).toContain("Speaking");
    expect(painted.kai).toContain('data-presence="up"');
    expect(painted.kai).toContain("data-up-mark");
    expect(painted.kai).not.toContain("data-live-pill");
    expect(painted.pepper).toContain('data-presence="waiting"');
    expect(painted.pepper).not.toContain("data-live-pill");
    expect(painted.pepper).not.toContain("data-up-mark");
    expect(html).toContain("Round 2 of 3");
    click(node, "roundtable-adjourn");
    expect(onAdjourn).toHaveBeenCalledWith("thread");
  });

  it("keeps the seats on a remote client and hides adjourn", () => {
    const html = markup(RoundtableStrip({
      group: room([table()]),
      members,
      remoteClient: true,
      onOpen: vi.fn(),
      onAdjourn: vi.fn(),
    }));
    expect(html).toContain('data-roundtable-member="kai"');
    expect(html).not.toContain("data-testid=\"roundtable-adjourn\"");
    expect(html).not.toContain("data-testid=\"roundtable-open\"");
  });
});
