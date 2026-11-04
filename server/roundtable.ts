import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { WireChairPresence, WireRoundtable, WireSeatPresence } from "../shared/wire.ts";
import { writeFileAtomic } from "./atomic.ts";

const ROUNDTABLE_SEAT_MISS_LIMIT = 2;
const FILE_NAME = "roundtables.json";

export interface RoundtableGroupView {
  id: string;
  dm?: boolean;
  setupPending: boolean;
  /** Every thread id the room owns, including the room root. */
  threadIds: readonly string[];
  members: readonly { id: string; name: string; hidden?: boolean }[];
  /** Active lead. The shell computes this with selectGroupGoalCoordinator. */
  leadBotId: string | null;
}

export type ThreadPending = "ready" | "working" | "goal" | "queued";

export interface RoundtableDeps {
  dataDir: string;
  now(): number;
  group(groupId: string): RoundtableGroupView | undefined;
  held(groupId: string, botId: string): boolean;
  pending(threadId: string): ThreadPending;
  onChanged(groupId: string): void;
  /** Abort the live group-turn operation on this thread, if one exists. */
  cancelThread(threadId: string): void;
  note(threadId: string, text: string): void;
  registerGrantTool(handler: GrantHandler): void;
}

export type GrantHandler = (
  call: { threadId: string; botId: string; decision: unknown },
) => { ok: true } | { ok: false; error: string };

export interface RoundtableRun {
  operationId: string;
  groupId: string;
  threadId: string;
  cancelled(): boolean;
  /** True when a further chat line is already in the channel queue. */
  humanWaiting(): boolean;
  runMember(turn: RoundtableMemberTurn): Promise<RoundtableMemberResult>;
}

export interface RoundtableMemberTurn {
  botId: string;
  role: "chair" | "seat";
  instructions: string;
}

export interface RoundtableMemberResult {
  outcome: "settled" | "unavailable" | "cancelled" | "failed";
}

export interface RoundtableTable {
  /** Validate `body` here. Throws Error & { status: number }. */
  open(groupId: string, threadId: string, body: unknown): WireRoundtable;
  /** Idempotent. Aborts a live operation when one holds the thread. */
  adjourn(groupId: string, threadId: string): void;
  /** True while an agenda exists and the phase is not adjourning. An invalid agenda stays true so the send cannot fall through. */
  live(threadId: string): boolean;
  run(ctx: RoundtableRun): Promise<void>;
  /**
   * Coordinator dispatch and the member-turn claim ask separately.
   * The released bot is `allow` for a member turn and `queue` for the coordinator.
   */
  admit(threadId: string, botId: string, via: "coordinator"): "allow" | "queue";
  admit(threadId: string, botId: string, via: "member-turn"): "allow" | "refuse";
  project(groupId: string, speakerOf: (threadId: string) => string | undefined): WireRoundtable[];
  /**
   * Deletes an adjourning row when its stored operation id is null or equals `operationId`.
   * A yield leaves the agenda for the drain that follows.
   */
  operationEnded(threadId: string, operationId: string): void;
}

type SeatGrant = "advance" | "skip" | "yield" | "adjourn";

interface RoundtableSeat {
  botId: string;
  state: "pending" | "done" | "skipped";
}

interface RoundtableSession {
  id: string;
  groupId: string;
  threadId: string;
  chairBotId: string;
  seats: RoundtableSeat[];
  /** 1-based. Never greater than `rounds`. */
  round: number;
  rounds: 1 | 2 | 3;
}

interface Misses {
  botId: string;
  count: number;
}

type LiveRoundtable =
  | { session: RoundtableSession; phase: { kind: "awaiting-person" } }
  | {
      session: RoundtableSession;
      phase: { kind: "chair"; botId: string };
      grant: SeatGrant | null;
      misses: Misses | null;
      operationId: string;
    }
  | {
      session: RoundtableSession;
      phase: { kind: "seat"; botId: string };
      misses: Misses | null;
      operationId: string;
    }
  | { session: RoundtableSession; phase: { kind: "adjourning"; operationId: string | null } };

type ChairLive = Extract<LiveRoundtable, { phase: { kind: "chair" } }>;
type SeatLive = Extract<LiveRoundtable, { phase: { kind: "seat" } }>;

function isChair(live: LiveRoundtable): live is ChairLive {
  return live.phase.kind === "chair";
}

function isSeat(live: LiveRoundtable): live is SeatLive {
  return live.phase.kind === "seat";
}

interface Eligibility {
  heldIds: ReadonlySet<string>;
  activeMemberIds: ReadonlySet<string>;
}

type RoundtableEvent =
  | { kind: "start"; operationId: string }
  | { kind: "grant"; decision: SeatGrant }
  | { kind: "chair-returned"; settled: boolean; humanWaiting: boolean; eligibility: Eligibility }
  | { kind: "seat-returned"; settled: boolean; humanWaiting: boolean; eligibility: Eligibility }
  | { kind: "cancel" }
  | { kind: "adjourn"; operationId: string | null }
  | { kind: "operation-ended"; operationId: string };

interface ReduceResult {
  live: LiveRoundtable | null;
  commit: "write" | "delete" | "none";
  speak?: { botId: string; role: "chair" | "seat" };
  note?: string;
}

/** A named thread whose agenda failed validation. The raw rows stay in the file so a later save cannot make the thread look empty. */
interface InvalidAgenda {
  kind: "invalid";
  groupId: string;
  threadId: string;
  raws: unknown[];
}

type MemoryRow =
  | { kind: "session"; live: LiveRoundtable }
  | InvalidAgenda;

function refuse(status: number, message: string): never {
  throw Object.assign(new Error(message), { status });
}

function unexpectedRoundtable(value: never): never {
  throw new Error(`unexpected roundtable case ${JSON.stringify(value)}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function roundCount(value: unknown): 1 | 2 | 3 | null {
  if (value === 1 || value === 2 || value === 3) return value;
  return null;
}

function seatState(value: unknown): RoundtableSeat["state"] | null {
  switch (value) {
    case "pending":
    case "done":
    case "skipped":
      return value;
    default:
      return null;
  }
}

function parseGrant(value: unknown): SeatGrant | null {
  switch (value) {
    case "advance":
    case "skip":
    case "yield":
    case "adjourn":
      return value;
    default:
      return null;
  }
}

function locate(value: unknown): { groupId: string; threadId: string } | null {
  if (!isRecord(value)) return null;
  if (typeof value.groupId !== "string" || value.groupId === "") return null;
  if (typeof value.threadId !== "string" || value.threadId === "") return null;
  return { groupId: value.groupId, threadId: value.threadId };
}

function parseSession(value: unknown): RoundtableSession | null {
  if (!isRecord(value)) return null;
  const id = value.id;
  const groupId = value.groupId;
  const threadId = value.threadId;
  const chairBotId = value.chairBotId;
  if (typeof id !== "string" || id === "") return null;
  if (typeof groupId !== "string" || groupId === "") return null;
  if (typeof threadId !== "string" || threadId === "") return null;
  if (typeof chairBotId !== "string" || chairBotId === "") return null;
  const rounds = roundCount(value.rounds);
  if (rounds === null) return null;
  if (typeof value.round !== "number" || !Number.isInteger(value.round) || value.round < 1 || value.round > rounds) return null;
  if (!Array.isArray(value.seats) || value.seats.length === 0) return null;
  const seats: RoundtableSeat[] = [];
  const seen = new Set<string>();
  for (const entry of value.seats) {
    if (!isRecord(entry) || typeof entry.botId !== "string" || entry.botId === "") return null;
    const state = seatState(entry.state);
    if (state === null || seen.has(entry.botId) || entry.botId === chairBotId) return null;
    seen.add(entry.botId);
    seats.push({ botId: entry.botId, state });
  }
  return { id, groupId, threadId, chairBotId, seats, round: value.round, rounds };
}

function awaiting(session: RoundtableSession): LiveRoundtable {
  return { session, phase: { kind: "awaiting-person" } };
}

function operationIdOf(live: LiveRoundtable): string | null {
  switch (live.phase.kind) {
    case "awaiting-person":
      return null;
    case "chair":
      if (!isChair(live)) throw new Error("chair phase has no operation");
      return live.operationId;
    case "seat":
      if (!isSeat(live)) throw new Error("seat phase has no operation");
      return live.operationId;
    case "adjourning":
      return live.phase.operationId;
    default: {
      const unexpected: never = live.phase;
      return unexpectedRoundtable(unexpected);
    }
  }
}

function markSeat(session: RoundtableSession, botId: string, state: RoundtableSeat["state"]): RoundtableSession {
  return {
    ...session,
    seats: session.seats.map((seat) => seat.botId === botId ? { botId, state } : seat),
  };
}

function activeIds(group: RoundtableGroupView | undefined): Set<string> {
  return new Set((group?.members ?? []).filter((member) => !member.hidden).map((member) => member.id));
}

function advance(
  session: RoundtableSession,
  eligibility: Eligibility,
  misses: Misses | null,
  operationId: string,
  written: boolean,
): ReduceResult {
  let sessionNow = session;
  let missesNow = misses;
  let writtenNow = written;
  for (;;) {
    const seat = sessionNow.seats.find((item) => item.state === "pending");
    if (!seat) {
      if (sessionNow.round < sessionNow.rounds) {
        sessionNow = {
          ...sessionNow,
          round: sessionNow.round + 1,
          seats: sessionNow.seats.map((item) => ({ botId: item.botId, state: "pending" })),
        };
        missesNow = null;
        writtenNow = true;
        continue;
      }
      return { live: awaiting(sessionNow), commit: writtenNow ? "write" : "none" };
    }
    if (!eligibility.activeMemberIds.has(seat.botId)) {
      sessionNow = markSeat(sessionNow, seat.botId, "skipped");
      writtenNow = true;
      continue;
    }
    if (eligibility.heldIds.has(seat.botId)) {
      return { live: awaiting(sessionNow), commit: writtenNow ? "write" : "none" };
    }
    return {
      live: {
        session: sessionNow,
        phase: { kind: "seat", botId: seat.botId },
        misses: missesNow?.botId === seat.botId ? missesNow : null,
        operationId,
      },
      commit: writtenNow ? "write" : "none",
      speak: { botId: seat.botId, role: "seat" },
    };
  }
}

function chairLeft(): ReduceResult {
  return { live: null, commit: "delete", note: "The chair left the room, so the roundtable ended." };
}

function reduce(live: LiveRoundtable, event: RoundtableEvent): ReduceResult {
  switch (event.kind) {
    case "start":
      if (live.phase.kind !== "awaiting-person") return { live, commit: "none" };
      return {
        live: {
          session: live.session,
          phase: { kind: "chair", botId: live.session.chairBotId },
          grant: null,
          misses: null,
          operationId: event.operationId,
        },
        commit: "none",
        speak: { botId: live.session.chairBotId, role: "chair" },
      };
    case "grant":
      if (live.phase.kind !== "chair") return { live, commit: "none" };
      return { live: { ...live, grant: event.decision }, commit: "none" };
    case "chair-returned":
      return reduceChairReturned(live, event);
    case "seat-returned":
      return reduceSeatReturned(live, event);
    case "cancel":
      if (live.phase.kind === "adjourning") return { live, commit: "none" };
      return { live: awaiting(live.session), commit: "none" };
    case "adjourn":
      if (live.phase.kind === "adjourning") return { live, commit: "none" };
      return {
        live: { session: live.session, phase: { kind: "adjourning", operationId: event.operationId } },
        commit: "none",
      };
    case "operation-ended":
      if (live.phase.kind === "adjourning" && (live.phase.operationId === null || live.phase.operationId === event.operationId)) {
        return { live: null, commit: "delete" };
      }
      return { live, commit: "none" };
    default: {
      const unexpected: never = event;
      return unexpectedRoundtable(unexpected);
    }
  }
}

function reduceChairReturned(live: LiveRoundtable, event: Extract<RoundtableEvent, { kind: "chair-returned" }>): ReduceResult {
  if (!isChair(live)) throw new Error(`chair-returned during ${live.phase.kind}`);
  if (!event.eligibility.activeMemberIds.has(live.session.chairBotId)) return chairLeft();
  if (event.humanWaiting || !event.settled) return { live: awaiting(live.session), commit: "none" };
  switch (live.grant) {
    case null:
    case "yield":
      return { live: awaiting(live.session), commit: "none" };
    case "adjourn":
      return {
        live: { session: live.session, phase: { kind: "adjourning", operationId: live.operationId } },
        commit: "none",
      };
    case "skip":
      return skipThenAdvance(live, event.eligibility);
    case "advance":
      return advance(live.session, event.eligibility, live.misses, live.operationId, false);
    default: {
      const unexpected: never = live.grant;
      return unexpectedRoundtable(unexpected);
    }
  }
}

function skipThenAdvance(live: ChairLive, eligibility: Eligibility): ReduceResult {
  const pending = live.session.seats.find((seat) => seat.state === "pending");
  if (!pending) return advance(live.session, eligibility, null, live.operationId, false);
  return advance(markSeat(live.session, pending.botId, "skipped"), eligibility, null, live.operationId, true);
}

function reduceSeatReturned(live: LiveRoundtable, event: Extract<RoundtableEvent, { kind: "seat-returned" }>): ReduceResult {
  if (!isSeat(live)) throw new Error(`seat-returned during ${live.phase.kind}`);
  if (!event.eligibility.activeMemberIds.has(live.session.chairBotId)) return chairLeft();
  if (event.humanWaiting) {
    if (!event.settled) return { live: awaiting(live.session), commit: "none" };
    return { live: awaiting(markSeat(live.session, live.phase.botId, "done")), commit: "write" };
  }
  if (!event.settled) return missSeat(live);
  const session = markSeat(live.session, live.phase.botId, "done");
  return {
    live: {
      session,
      phase: { kind: "chair", botId: session.chairBotId },
      grant: null,
      misses: null,
      operationId: live.operationId,
    },
    commit: "write",
    speak: { botId: session.chairBotId, role: "chair" },
  };
}

function missSeat(live: SeatLive): ReduceResult {
  const count = live.misses?.botId === live.phase.botId ? live.misses.count + 1 : 1;
  if (count >= ROUNDTABLE_SEAT_MISS_LIMIT) return { live: awaiting(live.session), commit: "none" };
  return {
    live: {
      session: live.session,
      phase: { kind: "chair", botId: live.session.chairBotId },
      grant: null,
      misses: { botId: live.phase.botId, count },
      operationId: live.operationId,
    },
    commit: "none",
    speak: { botId: live.session.chairBotId, role: "chair" },
  };
}

interface OpenBody {
  chairBotId?: string;
  seats?: string[];
  rounds?: 1 | 2 | 3;
}

function parseOpenBody(body: unknown, threadId: string): OpenBody {
  if (!isRecord(body)) refuse(400, "roundtable body must be an object");
  for (const key of Object.keys(body)) {
    if (key !== "threadId" && key !== "chairBotId" && key !== "seats" && key !== "rounds") refuse(400, `unknown field ${key}`);
  }
  if (body.threadId !== undefined && body.threadId !== threadId) refuse(400, "threadId does not match");
  let chairBotId: string | undefined;
  if (body.chairBotId !== undefined) {
    if (typeof body.chairBotId !== "string" || body.chairBotId === "") refuse(400, "chairBotId must be a bot id");
    chairBotId = body.chairBotId;
  }
  let seats: string[] | undefined;
  if (body.seats !== undefined) {
    if (!Array.isArray(body.seats) || body.seats.some((seat) => typeof seat !== "string" || seat === "")) {
      refuse(400, "seats must be bot ids");
    }
    seats = body.seats;
  }
  if (body.rounds === undefined) return { chairBotId, seats };
  const rounds = roundCount(body.rounds);
  if (rounds === null) refuse(400, "rounds must be 1, 2, or 3");
  return { chairBotId, seats, rounds };
}

function turnSettled(outcome: RoundtableMemberResult["outcome"]): boolean {
  switch (outcome) {
    case "settled":
      return true;
    case "unavailable":
    case "failed":
    case "cancelled":
      return false;
    default: {
      const unexpected: never = outcome;
      return unexpectedRoundtable(unexpected);
    }
  }
}

function chairPresence(phase: LiveRoundtable["phase"], speaker: string | undefined, chairBotId: string): WireChairPresence {
  if (speaker === chairBotId) return "speaking";
  switch (phase.kind) {
    case "chair":
      return speaker === undefined ? "up" : "idle";
    case "awaiting-person":
    case "seat":
    case "adjourning":
      return "idle";
    default: {
      const unexpected: never = phase;
      return unexpectedRoundtable(unexpected);
    }
  }
}

function releasedUnclaimed(phase: LiveRoundtable["phase"], botId: string, speaker: string | undefined): boolean {
  switch (phase.kind) {
    case "seat":
      return phase.botId === botId && speaker === undefined;
    case "awaiting-person":
    case "chair":
    case "adjourning":
      return false;
    default: {
      const unexpected: never = phase;
      return unexpectedRoundtable(unexpected);
    }
  }
}

export function createRoundtableTable(deps: RoundtableDeps): RoundtableTable {
  const file = join(deps.dataDir, FILE_NAME);
  const byThread = new Map<string, MemoryRow>();

  const writeAgenda = (): void => {
    const sessions: unknown[] = [];
    for (const row of byThread.values()) {
      if (row.kind === "invalid") sessions.push(...row.raws);
      else sessions.push(row.live.session);
    }
    mkdirSync(deps.dataDir, { recursive: true });
    writeFileAtomic(file, `${JSON.stringify({ version: 1, sessions })}\n`, { mode: 0o600 });
  };

  const load = (): void => {
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return;
      console.warn(`roundtable: skipped ${file} (${code ?? "unreadable"})`);
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      console.warn(`roundtable: skipped ${file} (not JSON)`);
      return;
    }
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.sessions)) {
      console.warn(`roundtable: skipped ${file} (version is not 1)`);
      return;
    }
    const grouped = new Map<string, { groupId: string; raws: unknown[] }>();
    for (const row of parsed.sessions) {
      const place = locate(row);
      if (!place) {
        console.warn("roundtable: skipped a row with no thread");
        continue;
      }
      const group = deps.group(place.groupId);
      if (!group || !group.threadIds.includes(place.threadId)) {
        console.warn(`roundtable: dropped ${place.threadId} (room or thread is gone)`);
        continue;
      }
      const bucket = grouped.get(place.threadId);
      if (bucket) bucket.raws.push(row);
      else grouped.set(place.threadId, { groupId: place.groupId, raws: [row] });
    }
    for (const [threadId, bucket] of grouped) {
      const session = bucket.raws.length === 1 ? parseSession(bucket.raws[0]) : null;
      if (!session || session.threadId !== threadId || session.groupId !== bucket.groupId) {
        console.warn(`roundtable: ${threadId} is present but invalid`);
        byThread.set(threadId, { kind: "invalid", groupId: bucket.groupId, threadId, raws: bucket.raws });
        continue;
      }
      byThread.set(threadId, { kind: "session", live: awaiting(session) });
    }
  };

  const apply = (live: LiveRoundtable, event: RoundtableEvent): ReduceResult => {
    const result = reduce(live, event);
    if (result.live === null) byThread.delete(live.session.threadId);
    else byThread.set(live.session.threadId, { kind: "session", live: result.live });
    if (result.commit === "write" || result.commit === "delete") writeAgenda();
    if (result.note) deps.note(live.session.threadId, result.note);
    if (result.live !== live || result.commit !== "none") deps.onChanged(live.session.groupId);
    return result;
  };

  const readLive = (threadId: string): LiveRoundtable | null => {
    const row = byThread.get(threadId);
    if (!row || row.kind !== "session") return null;
    return row.live;
  };

  const eligibilityFor = (session: RoundtableSession): Eligibility => {
    const heldIds = new Set<string>();
    for (const seat of session.seats) {
      if (deps.held(session.groupId, seat.botId)) heldIds.add(seat.botId);
    }
    return { heldIds, activeMemberIds: activeIds(deps.group(session.groupId)) };
  };

  const memberName = (groupId: string, botId: string): string =>
    deps.group(groupId)?.members.find((member) => member.id === botId)?.name || botId;

  const chairTurn = (live: ChairLive): RoundtableMemberTurn => {
    const next = live.session.seats.find((seat) => seat.state === "pending");
    const lines = [
      `Round ${live.session.round} of ${live.session.rounds}.`,
      next ? `The next seat is ${memberName(live.session.groupId, next.botId)}.` : "No seat is pending.",
    ];
    if (live.misses) lines.push(`${memberName(live.session.groupId, live.misses.botId)} did not take the seat and is still pending.`);
    lines.push(
      "Record grant_seat with advance, skip, yield, or adjourn.",
      "advance calls the next pending seat. skip marks that seat skipped, then advances. yield returns the floor to the person. adjourn ends the roundtable.",
      "End the turn after grant_seat.",
    );
    return { botId: live.phase.botId, role: "chair", instructions: lines.join("\n") };
  };

  const seatTurn = (live: SeatLive): RoundtableMemberTurn => ({
    botId: live.phase.botId,
    role: "seat",
    instructions: [
      `${memberName(live.session.groupId, live.session.chairBotId)} has the chair.`,
      "Speak on your turn.",
      "Do not call grant_seat.",
    ].join("\n"),
  });

  const nextCallable = (live: LiveRoundtable, active: ReadonlySet<string>): string | undefined => {
    switch (live.phase.kind) {
      case "awaiting-person":
      case "chair":
        break;
      case "seat":
      case "adjourning":
        return undefined;
      default: {
        const unexpected: never = live.phase;
        return unexpectedRoundtable(unexpected);
      }
    }
    for (const seat of live.session.seats) {
      if (seat.state !== "pending") continue;
      if (active.has(seat.botId) && !deps.held(live.session.groupId, seat.botId)) return seat.botId;
      return undefined;
    }
    return undefined;
  };

  const seatPresence = (
    live: LiveRoundtable,
    seat: RoundtableSeat,
    speaker: string | undefined,
    active: ReadonlySet<string>,
    callableId: string | undefined,
  ): WireSeatPresence => {
    if (speaker === seat.botId) return "speaking";
    if (releasedUnclaimed(live.phase, seat.botId, speaker)) return "up";
    if (seat.botId === callableId) return "up";
    switch (seat.state) {
      case "done":
        return "done";
      case "skipped":
        return "skipped";
      case "pending":
        if (deps.held(live.session.groupId, seat.botId) || !active.has(seat.botId)) return "held";
        return "waiting";
      default: {
        const unexpected: never = seat.state;
        return unexpectedRoundtable(unexpected);
      }
    }
  };

  const view = (live: LiveRoundtable, speaker: string | undefined): WireRoundtable => {
    const active = activeIds(deps.group(live.session.groupId));
    const callableId = nextCallable(live, active);
    return {
      threadId: live.session.threadId,
      chairBotId: live.session.chairBotId,
      chairPresence: chairPresence(live.phase, speaker, live.session.chairBotId),
      round: live.session.round,
      rounds: live.session.rounds,
      phase: live.phase.kind,
      seats: live.session.seats.map((seat) => ({
        botId: seat.botId,
        presence: seatPresence(live, seat, speaker, active, callableId),
      })),
    };
  };

  const onGrant: GrantHandler = (call) => {
    const decision = parseGrant(call.decision);
    if (!decision) return { ok: false, error: "decision must be advance, skip, yield, or adjourn" };
    const row = byThread.get(call.threadId);
    if (!row || row.kind !== "session" || row.live.phase.kind !== "chair" || row.live.phase.botId !== call.botId) {
      return { ok: false, error: "only the released chair can grant a seat" };
    }
    const result = reduce(row.live, { kind: "grant", decision });
    if (result.live) byThread.set(call.threadId, { kind: "session", live: result.live });
    return { ok: true };
  };

  const open = (groupId: string, threadId: string, body: unknown): WireRoundtable => {
    const group = deps.group(groupId);
    if (!group) refuse(404, "no such room");
    if (group.dm) refuse(400, "a direct message has no roundtable");
    if (group.setupPending) refuse(409, "finish room setup first");
    if (!group.threadIds.includes(threadId)) refuse(404, "no such thread");
    if (byThread.has(threadId)) refuse(409, "a roundtable is already in session on this thread");
    if (deps.pending(threadId) !== "ready") refuse(409, "this thread is busy");
    const parsed = parseOpenBody(body, threadId);
    const active = group.members.filter((member) => !member.hidden);
    const lead = group.leadBotId && active.some((member) => member.id === group.leadBotId) ? group.leadBotId : undefined;
    const chairBotId = parsed.chairBotId ?? lead ?? active[0]?.id;
    if (!chairBotId || !active.some((member) => member.id === chairBotId)) refuse(400, "the chair is not an active member");
    const seatIds = parsed.seats ?? active.map((member) => member.id).filter((id) => id !== chairBotId);
    if (seatIds.length === 0) refuse(400, "a roundtable needs a seat");
    if (new Set(seatIds).size !== seatIds.length) refuse(400, "seats must be unique");
    if (seatIds.includes(chairBotId)) refuse(400, "the chair is not a seat");
    if (seatIds.some((id) => !active.some((member) => member.id === id))) refuse(400, "every seat must be an active member");
    const session: RoundtableSession = {
      id: randomUUID(),
      groupId,
      threadId,
      chairBotId,
      seats: seatIds.map((botId) => ({ botId, state: "pending" })),
      round: 1,
      rounds: parsed.rounds ?? 1,
    };
    const live = awaiting(session);
    byThread.set(threadId, { kind: "session", live });
    writeAgenda();
    deps.onChanged(groupId);
    return view(live, undefined);
  };

  const adjourn = (groupId: string, threadId: string): void => {
    const row = byThread.get(threadId);
    if (!row) return;
    const owner = row.kind === "session" ? row.live.session.groupId : row.groupId;
    if (owner !== groupId) return;
    if (row.kind === "invalid") {
      byThread.delete(threadId);
      writeAgenda();
      deps.cancelThread(threadId);
      deps.onChanged(groupId);
      return;
    }
    if (row.live.phase.kind === "awaiting-person" && deps.pending(threadId) === "ready") {
      byThread.delete(threadId);
      writeAgenda();
      deps.onChanged(groupId);
      return;
    }
    if (row.live.phase.kind === "adjourning") {
      deps.cancelThread(threadId);
      return;
    }
    apply(row.live, { kind: "adjourn", operationId: operationIdOf(row.live) });
    deps.cancelThread(threadId);
  };

  const live = (threadId: string): boolean => {
    const row = byThread.get(threadId);
    if (!row) return false;
    if (row.kind === "invalid") return true;
    switch (row.live.phase.kind) {
      case "awaiting-person":
      case "chair":
      case "seat":
        return true;
      case "adjourning":
        return false;
      default: {
        const unexpected: never = row.live.phase;
        return unexpectedRoundtable(unexpected);
      }
    }
  };

  const releaseStopped = (current: LiveRoundtable, ctx: RoundtableRun, outcome: RoundtableMemberResult["outcome"]): boolean => {
    if (current.phase.kind === "adjourning") return true;
    if (outcome === "cancelled" || ctx.cancelled()) {
      apply(current, { kind: "cancel" });
      return true;
    }
    return false;
  };

  const run = async (ctx: RoundtableRun): Promise<void> => {
    const row = byThread.get(ctx.threadId);
    if (!row) return;
    if (row.kind === "invalid") refuse(409, "a roundtable agenda on this thread is unreadable");
    if (row.live.session.groupId !== ctx.groupId || row.live.phase.kind !== "awaiting-person") return;
    const started = apply(row.live, { kind: "start", operationId: ctx.operationId });
    if (!started.live || started.live.phase.kind !== "chair") return;
    let current: LiveRoundtable = started.live;
    for (;;) {
      if (!isChair(current)) return;
      const chair = current;
      if (ctx.cancelled()) {
        apply(chair, { kind: "cancel" });
        return;
      }
      const chairResult = await ctx.runMember(chairTurn(chair));
      const afterChairLive = readLive(ctx.threadId);
      if (!afterChairLive || releaseStopped(afterChairLive, ctx, chairResult.outcome)) return;
      const afterChair = apply(afterChairLive, {
        kind: "chair-returned",
        settled: turnSettled(chairResult.outcome),
        humanWaiting: ctx.humanWaiting(),
        eligibility: eligibilityFor(afterChairLive.session),
      });
      const released = afterChair.live;
      if (afterChair.speak?.role !== "seat" || !released || !isSeat(released)) return;
      if (ctx.cancelled()) {
        apply(released, { kind: "cancel" });
        return;
      }
      const seatResult = await ctx.runMember(seatTurn(released));
      const afterSeatLive = readLive(ctx.threadId);
      if (!afterSeatLive || releaseStopped(afterSeatLive, ctx, seatResult.outcome)) return;
      const afterSeat = apply(afterSeatLive, {
        kind: "seat-returned",
        settled: turnSettled(seatResult.outcome),
        humanWaiting: ctx.humanWaiting(),
        eligibility: eligibilityFor(afterSeatLive.session),
      });
      const next = afterSeat.live;
      if (afterSeat.speak?.role !== "chair" || !next || !isChair(next)) return;
      current = next;
    }
  };

  function admit(threadId: string, botId: string, via: "coordinator"): "allow" | "queue";
  function admit(threadId: string, botId: string, via: "member-turn"): "allow" | "refuse";
  function admit(threadId: string, botId: string, via: "coordinator" | "member-turn"): "allow" | "queue" | "refuse" {
    const row = byThread.get(threadId);
    if (!row) return "allow";
    switch (via) {
      case "coordinator":
        return "queue";
      case "member-turn":
        if (
          row.kind === "session"
          && (isChair(row.live) || isSeat(row.live))
          && row.live.phase.botId === botId
        ) return "allow";
        return "refuse";
      default: {
        const unexpected: never = via;
        return unexpectedRoundtable(unexpected);
      }
    }
  }

  const project = (groupId: string, speakerOf: (threadId: string) => string | undefined): WireRoundtable[] => {
    const views: WireRoundtable[] = [];
    for (const row of byThread.values()) {
      if (row.kind !== "session" || row.live.session.groupId !== groupId) continue;
      views.push(view(row.live, speakerOf(row.live.session.threadId)));
    }
    return views;
  };

  const operationEnded = (threadId: string, operationId: string): void => {
    const row = byThread.get(threadId);
    if (!row || row.kind !== "session") return;
    apply(row.live, { kind: "operation-ended", operationId });
  };

  load();
  deps.registerGrantTool(onGrant);
  return { open, adjourn, live, run, admit, project, operationEnded };
}
