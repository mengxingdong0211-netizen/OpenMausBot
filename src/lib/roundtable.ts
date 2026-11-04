import type { WireRoundtable } from "../../shared/wire";
import { t } from "./i18n";

export function threadRoundtable(
  group: { threadId: string; roundtables?: readonly WireRoundtable[] },
  threadId = group.threadId,
): WireRoundtable | undefined {
  return group.roundtables?.find((row) => row.threadId === threadId);
}

export function roundtableIdleHint(
  table: WireRoundtable,
  nameOf: (botId: string) => string,
): string {
  const chair = nameOf(table.chairBotId);
  switch (table.phase) {
    case "awaiting-person": {
      const next = table.seats.find((seat) => seat.presence === "up");
      return next
        ? t("roundtable.hint.awaitingNext", { chair, name: nameOf(next.botId) })
        : t("roundtable.hint.toChair", { chair });
    }
    case "chair":
    case "seat":
    case "adjourning":
      return t("roundtable.hint.toChair", { chair });
    default: {
      const unexpected: never = table.phase;
      return unexpectedPhase(unexpected);
    }
  }
}

function unexpectedPhase(phase: never): never {
  throw new Error(`unexpected roundtable phase ${JSON.stringify(phase)}`);
}
