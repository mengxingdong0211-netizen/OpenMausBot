import type { ReactNode } from "react";

import { cn } from "@/lib/cn";
import { t } from "@/lib/i18n";
import { threadRoundtable } from "@/lib/roundtable";
import type { LocaleKey } from "@/locales";
import type { Group } from "@/state/store";
import type { MausColor, WireChairPresence, WireSeatPresence } from "../../shared/wire";
import { BotAvatar } from "./Avatar";

type Member = { id: string; name: string; color: MausColor };
type Presence = WireChairPresence | WireSeatPresence;

export function RoundtableStrip({
  group,
  members,
  remoteClient,
  onOpen,
  onAdjourn,
}: {
  group: Group;
  members: readonly Member[];
  remoteClient: boolean;
  onOpen(body: { threadId: string; chairBotId?: string; seats?: string[]; rounds?: 1 | 2 | 3 }): void;
  onAdjourn(threadId: string): void;
}) {
  const table = threadRoundtable(group);
  if (!table) {
    if (remoteClient || members.length < 2) return null;
    return (
      <Strip>
        <button
          type="button"
          data-testid="roundtable-open"
          onClick={() => onOpen({ threadId: group.threadId })}
          className="cursor-pointer rounded-full px-2 py-0.5 text-[12px] text-accent hover:bg-accent/10"
        >
          {t("roundtable.open")}
        </button>
      </Strip>
    );
  }
  const chair = memberOf(members, table.chairBotId);
  return (
    <Strip phase={table.phase}>
      <SeatCell member={chair} presence={table.chairPresence} role="chair" />
      {table.seats.map((seat) => (
        <SeatCell key={seat.botId} member={memberOf(members, seat.botId)} presence={seat.presence} role="seat" />
      ))}
      <span className="text-[12px] text-ink-tertiary">{t("roundtable.round", { round: table.round, rounds: table.rounds })}</span>
      {!remoteClient && (
        <button
          type="button"
          data-testid="roundtable-adjourn"
          onClick={() => onAdjourn(table.threadId)}
          className="cursor-pointer rounded-full px-2 py-0.5 text-[12px] text-ink-secondary hover:bg-raised hover:text-ink"
        >
          {t("roundtable.adjourn")}
        </button>
      )}
    </Strip>
  );
}

function Strip({ phase, children }: { phase?: string; children: ReactNode }) {
  return (
    <div className="w-full px-5">
      <div
        data-testid="roundtable-strip"
        data-roundtable-phase={phase}
        role="group"
        aria-label={t("roundtable.region")}
        className="mb-1 flex flex-wrap items-center gap-1.5 px-2"
      >
        {children}
      </div>
    </div>
  );
}

function SeatCell({ member, presence, role }: { member: Member; presence: Presence; role: "chair" | "seat" }) {
  const view = presenceView(presence);
  return (
    <span
      data-roundtable-member={member.id}
      data-roundtable-role={role}
      data-presence={presence}
      data-live-pill={view.face === "pill" ? "" : undefined}
      aria-label={t("roundtable.member", { name: member.name, presence: t(view.label) })}
      className={cn(
        "inline-flex max-w-full items-center gap-1.5 rounded-full py-0.5 pe-2 ps-0.5 text-[12px]",
        view.face === "pill" ? "bg-accent/10 text-accent ring-1 ring-inset ring-accent/35" : "text-ink",
        (presence === "done" || presence === "skipped") && "opacity-50",
      )}
    >
      <BotAvatar bot={{ name: member.name, color: member.color }} size={18} animated={false} motion="none" />
      <span className="max-w-[8rem] truncate">{member.name}</span>
      {role === "chair" && (
        <span className={view.face === "pill" ? "opacity-80" : "text-ink-tertiary"}>{t("roundtable.chair")}</span>
      )}
      {view.face === "pill" && <span className="font-medium">{t(view.label)}</span>}
      {view.face === "mark" && (
        <span data-up-mark title={t(view.label)} className="size-1.5 shrink-0 rounded-full bg-accent">
          <span className="sr-only">{t(view.label)}</span>
        </span>
      )}
    </span>
  );
}

function memberOf(members: readonly Member[], id: string): Member {
  return members.find((member) => member.id === id) ?? { id, name: id, color: "green" };
}

function presenceView(presence: Presence): { face: "pill" | "mark" | "quiet"; label: LocaleKey } {
  switch (presence) {
    case "speaking":
      return { face: "pill", label: "roundtable.presence.speaking" };
    case "up":
      return { face: "mark", label: "roundtable.presence.up" };
    case "idle":
      return { face: "quiet", label: "roundtable.presence.idle" };
    case "waiting":
      return { face: "quiet", label: "roundtable.presence.waiting" };
    case "done":
      return { face: "quiet", label: "roundtable.presence.done" };
    case "skipped":
      return { face: "quiet", label: "roundtable.presence.skipped" };
    case "held":
      return { face: "quiet", label: "roundtable.presence.held" };
    default: {
      const unexpected: never = presence;
      throw new Error(`unexpected roundtable presence ${JSON.stringify(unexpected)}`);
    }
  }
}
