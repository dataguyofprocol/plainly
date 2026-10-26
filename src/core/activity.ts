/**
 * THE ACTIVITY FOLDS (v4 redesign, owner-approved 2026-10-26): every
 * progress number the redesigned home, session list, and knowledge view
 * show — derived at read time from what is already stored. Nothing here
 * persists anything; the only new storage is the append-only time ledger
 * (contracts/activity.ts TimeBeat), and it is folded here too.
 *
 * Laws carried over from the codebase:
 *   - POSITION, NEVER MASTERY: plan progress reads the derived statuses
 *     (contracts/plan.ts derivePlanStatusesLh — quiz CALLS tag position).
 *   - HONEST ACTIVATION: practice problems and concludes count only
 *     through their clean results (native-messages.ts activeProblemOf's
 *     rule — errored/dangling calls never happened).
 *   - MONEY: dollars are inferred by an injected pricer (server-side Pi
 *     catalog), never stored; unknown price is null, never zero.
 *   - LOCAL TIME: day/week/month boundaries use the process's local time
 *     zone — a desktop app's server runs on the learner's machine.
 *
 * Pure + browser-safe: no node builtins, no clock reads (every function
 * that needs "now" takes it), no store reads.
 */

import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { CallUsage, ChatKind, Cluster, GraphNode, PlanTree } from "./contracts.ts";
import { derivePlanStatusesLh } from "./contracts/plan.ts";
import {
	PRACTICE_SET_SIZE,
	type ChatProgress,
	type ChatState,
	type DailyStatsDay,
	type DailyStatsResponse,
	type StatsPeriod,
	type StatsResponse,
	type TimeBeat,
	type Topic,
	type WeekdayLabel,
} from "./contracts/activity.ts";
import {
	PRACTICE_CONCLUDE_TOOL,
	activeProblemOf,
	danglingQuestionOf,
	type LhMarkerMessage,
	type LhMessage,
} from "./native-messages.ts";

// ─── the time ledger ────────────────────────────────────────────────────────

/** The most one beat may credit: the client beats every 30s; a late beat
 *  may carry up to a minute, never more (a sleeping laptop must not mint
 *  hours on wake). */
export const MAX_BEAT_SECONDS = 60;

/** Clamp a client-reported beat to 0..MAX_BEAT_SECONDS (non-numbers and
 *  non-finite values credit nothing). */
export function clampBeatSeconds(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	return Math.min(Math.max(value, 0), MAX_BEAT_SECONDS);
}

const pad2 = (n: number): string => String(n).padStart(2, "0");

/** The LOCAL calendar date of an instant, "YYYY-MM-DD". */
export function localDateKey(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/** The LOCAL month of an instant, "YYYY-MM" — the ledger file key. */
export function localMonthKey(d: Date): string {
	return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
}

/** Monday 00:00 local of the week containing `now`. */
export function weekStartOf(now: Date): Date {
	const sinceMonday = (now.getDay() + 6) % 7; // Sun=0 → 6, Mon=1 → 0
	return new Date(now.getFullYear(), now.getMonth(), now.getDate() - sinceMonday);
}

/** The 1st of the month 00:00 local. */
export function monthStartOf(now: Date): Date {
	return new Date(now.getFullYear(), now.getMonth(), 1);
}

/** A stats period's window and its comparison window. The current window
 *  is [start, end] (end = now). The PREVIOUS EQUAL period starts at the
 *  previous period's start and spans the same elapsed time — "this week
 *  so far vs last week up to the same moment" — capped at `start` (a
 *  31-day month's elapsed span never spills into this month). */
export interface PeriodWindow {
	start: Date;
	end: Date;
	prevStart: Date;
	prevEnd: Date;
}

export function periodWindow(period: StatsPeriod, now: Date): PeriodWindow {
	const start = period === "week" ? weekStartOf(now) : monthStartOf(now);
	const prevStart =
		period === "week"
			? new Date(start.getFullYear(), start.getMonth(), start.getDate() - 7)
			: new Date(start.getFullYear(), start.getMonth() - 1, 1);
	const elapsed = now.getTime() - start.getTime();
	const prevEnd = new Date(Math.min(prevStart.getTime() + elapsed, start.getTime()));
	return { start, end: now, prevStart, prevEnd };
}

/** Is an ISO instant inside [start, end]? Unparseable → false. */
export function inWindow(iso: string | undefined, start: Date, end: Date): boolean {
	if (!iso) return false;
	const t = Date.parse(iso);
	return Number.isFinite(t) && t >= start.getTime() && t <= end.getTime();
}

/** Active seconds of the beats in [start, end) — half-open so adjacent
 *  windows never double-count a beat on the seam; `endInclusive` closes
 *  it for "up to now" windows. */
export function beatSecondsIn(beats: readonly TimeBeat[], start: Date, end: Date, endInclusive = false): number {
	let total = 0;
	const s = start.getTime();
	const e = end.getTime();
	for (const beat of beats) {
		const t = Date.parse(beat.at);
		if (!Number.isFinite(t) || t < s || (endInclusive ? t > e : t >= e)) continue;
		total += clampBeatSeconds(beat.seconds);
	}
	return total;
}

/** All-time active seconds per chat (the session list's `minutes`). */
export function beatSecondsByChat(beats: readonly TimeBeat[]): Map<string, number> {
	const out = new Map<string, number>();
	for (const beat of beats) out.set(beat.chatId, (out.get(beat.chatId) ?? 0) + clampBeatSeconds(beat.seconds));
	return out;
}

const WEEKDAYS: readonly WeekdayLabel[] = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** The home's week strip: the current week Monday → Sunday, minutes per
 *  LOCAL day (rounded; future days 0), and how many days up to today met
 *  the goal. */
export function dailyStats(beats: readonly TimeBeat[], now: Date, goalMinutes: number): DailyStatsResponse {
	const secondsByDay = new Map<string, number>();
	for (const beat of beats) {
		const t = Date.parse(beat.at);
		if (!Number.isFinite(t) || t > now.getTime()) continue;
		const key = localDateKey(new Date(t));
		secondsByDay.set(key, (secondsByDay.get(key) ?? 0) + clampBeatSeconds(beat.seconds));
	}
	const monday = weekStartOf(now);
	const todayKey = localDateKey(now);
	let passedToday = false;
	let metDays = 0;
	const days: DailyStatsDay[] = WEEKDAYS.map((label, i) => {
		const date = localDateKey(new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i));
		const today = date === todayKey;
		const future = passedToday;
		if (today) passedToday = true;
		const minutes = future ? 0 : Math.round((secondsByDay.get(date) ?? 0) / 60);
		if (!future && minutes >= goalMinutes) metDays++;
		return { date, label, minutes, today };
	});
	return { goalMinutes, days, metDays };
}

// ─── per-session progress (the session list) ────────────────────────────────

/** The pending text's length cap (the list row's one line). */
export const PENDING_TEXT_MAX = 140;

/** Markdown → one plain line, capped at `max` chars on a word boundary
 *  with an ellipsis. Light-touch by design: links keep their text,
 *  emphasis/code/heading/quote markers drop, whitespace collapses. Math
 *  delimiters stay (the row may render inline math); a cut that would
 *  leave an unbalanced `$` cuts before it instead. Null for non-strings
 *  and empty results. */
export function plainText(raw: unknown, max = PENDING_TEXT_MAX): string | null {
	if (typeof raw !== "string") return null;
	let text = raw
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
		.replace(/```[\s\S]*?```/g, " ")
		.replace(/[*_`~]+/g, "")
		.replace(/^\s{0,3}(#{1,6}|>|[-+]|\d+\.)\s+/gm, "")
		.replace(/\s+/g, " ")
		.trim();
	if (text.length === 0) return null;
	if (text.length <= max) return text;
	let cut = text.slice(0, max - 1);
	const space = cut.lastIndexOf(" ");
	if (space > max * 0.6) cut = cut.slice(0, space);
	if ((cut.match(/\$/g)?.length ?? 0) % 2 === 1) cut = cut.slice(0, cut.lastIndexOf("$"));
	text = `${cut.trimEnd()}…`;
	return text;
}

/** Clean (non-errored) tool results by call id. */
function cleanResults(messages: readonly LhMessage[]): Map<string, ToolResultMessage> {
	const out = new Map<string, ToolResultMessage>();
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as unknown as ToolResultMessage;
		if (!result.isError) out.set(result.toolCallId, result);
	}
	return out;
}

/** One practice conclusion: its outcome and when its clean ack landed. */
export interface ConcludedProblem {
	outcome: string;
	/** ISO of the conclude's clean result (the moment it went through). */
	at: string;
}

/** Every CLEAN conclude in record order (the dismissal-synthesized pair
 *  included — it is a conclude with outcome "dismissed"). */
export function concludedProblemsOf(messages: readonly LhMessage[]): ConcludedProblem[] {
	const clean = cleanResults(messages);
	const out: ConcludedProblem[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		for (const block of (m as unknown as AssistantMessage).content) {
			if (block.type !== "toolCall" || block.name !== PRACTICE_CONCLUDE_TOOL) continue;
			const result = clean.get(block.id);
			if (!result) continue;
			const outcome = (block.arguments as { outcome?: unknown } | undefined)?.outcome;
			out.push({
				outcome: typeof outcome === "string" ? outcome : "unknown",
				at: new Date(result.timestamp).toISOString(),
			});
		}
	}
	return out;
}

/** The practice set fold: done-in-current-set + whether a whole set just
 *  closed (see contracts/activity.ts PracticeSetProgress). */
export function practiceSetOf(concluded: number, active: boolean): { size: number; done: number; complete: boolean } {
	const size = PRACTICE_SET_SIZE;
	if (concluded === 0) return { size, done: 0, complete: false };
	const rem = concluded % size;
	if (rem !== 0) return { size, done: rem, complete: false };
	// A multiple of the set size: the set is complete — until the next
	// set's first problem is posed (active), which reads 0 again.
	return active ? { size, done: 0, complete: false } : { size, done: size, complete: true };
}

/** The graded quiz-answer fold (see contracts/activity.ts ChatAnswerStats). */
export function answerStatsOf(messages: readonly LhMessage[]): { total: number; firstTry: number } {
	let total = 0;
	let firstTry = 0;
	for (const m of messages) {
		if ((m as { role?: string }).role !== "toolResult") continue;
		const result = m as unknown as ToolResultMessage;
		if (result.isError || (result.toolName !== "quiz" && result.toolName !== "probe")) continue;
		const details = result.details as { kind?: unknown; dismissed?: unknown; correct?: unknown } | undefined;
		if (details?.kind !== "quiz" || details.dismissed === true) continue;
		total++;
		if (details.correct === true) firstTry++;
	}
	return { total, firstTry };
}

/** The record-derived progress of one session (no liveness — see
 *  chatStateOf). Pure; reads only what the stored record carries. */
export function chatProgressOf(record: { kind?: ChatKind; tree?: PlanTree; messages: readonly LhMessage[] }): ChatProgress {
	const messages = record.messages;
	const pending = danglingQuestionOf(messages);
	const pendingQuestionText = pending
		? plainText((pending.input as { question?: unknown } | undefined)?.question)
		: null;

	if ((record.kind ?? "teach") === "practice") {
		const active = activeProblemOf(messages);
		const set = practiceSetOf(concludedProblemsOf(messages).length, active !== null);
		const restingState = pending || active ? "waiting" : set.complete ? "finished" : "paused";
		return {
			restingState,
			pendingQuestionText:
				pendingQuestionText ??
				(active ? plainText((active.input as { statement?: unknown } | undefined)?.statement) : null),
			plan: null,
			answers: null,
			practiceSet: { size: set.size, done: set.done },
		};
	}

	const tree = record.tree;
	let plan: ChatProgress["plan"] = null;
	let planDone = false;
	if (tree && tree.nodes.length > 0) {
		const statuses = derivePlanStatusesLh(tree, messages);
		const index = statuses.current === null ? -1 : tree.nodes.findIndex((n) => n.id === statuses.current);
		const visited = [...statuses.visited].filter((id) => id !== statuses.current).length;
		plan = { total: tree.nodes.length, visited, current: index >= 0 ? index + 1 : null };
		const reached = new Set(statuses.visited);
		if (statuses.current !== null) reached.add(statuses.current);
		planDone = index === tree.nodes.length - 1 || tree.nodes.every((n) => reached.has(n.id));
	}
	return {
		restingState: pending ? "waiting" : planDone ? "finished" : "paused",
		pendingQuestionText,
		plan,
		answers: answerStatsOf(messages),
		practiceSet: null,
	};
}

/** The row state: a running turn outranks everything (working). */
export function chatStateOf(progress: Pick<ChatProgress, "restingState">, busy: boolean): ChatState {
	return busy ? "working" : progress.restingState;
}

// ─── period stats (the home) ────────────────────────────────────────────────

/** One priced usage entry: when it billed, its tokens, its inferred
 *  dollars (null = unpriced — unknown model, subscription, or a
 *  provider that never reported the billable fields). */
export interface UsagePart {
	at: string;
	tokens: number;
	dollars: number | null;
}

/** Tokens of one call: input + output + cache reads + cache writes
 *  (reasoning is already inside output; absent fields add nothing). */
export function callTokens(step: Partial<CallUsage>): number {
	return (step.inputTokens ?? 0) + (step.outputTokens ?? 0) + (step.cacheReadTokens ?? 0) + (step.cacheWriteTokens ?? 0);
}

/** Fold parts in [start, end] into the stats' token block. dollars: sum
 *  of the priced parts; null only when parts exist and none priced; 0
 *  when the window billed nothing at all. */
export function foldUsage(parts: readonly UsagePart[], start: Date, end: Date): { total: number; dollars: number | null } {
	let total = 0;
	let dollars = 0;
	let any = false;
	let priced = false;
	for (const part of parts) {
		if (!inWindow(part.at, start, end)) continue;
		any = true;
		total += part.tokens;
		if (part.dollars !== null) {
			priced = true;
			dollars += part.dollars;
		}
	}
	return { total, dollars: any && !priced ? null : dollars };
}

/** What the stats fold reads — the server gathers it from the stores. */
export interface StatsInput {
	/** Every session: its kind, updatedAt, record messages, and progress. */
	chats: ReadonlyArray<{ kind: ChatKind; updatedAt: string; messages: readonly LhMessage[]; progress: ChatProgress }>;
	/** Raw node ledger lines (deduped by id here — first line defines). */
	nodes: readonly GraphNode[];
	beats: readonly TimeBeat[];
	/** Every usage channel, already priced (server-side pricer). */
	usage: readonly UsagePart[];
}

export function buildStats(input: StatsInput, period: StatsPeriod, now: Date): StatsResponse {
	const w = periodWindow(period, now);
	const lessons = { active: 0, waiting: 0, finished: 0, allTime: 0 };
	const practice = { problems: 0, solid: 0 };
	for (const chat of input.chats) {
		if (chat.kind === "practice") {
			for (const c of concludedProblemsOf(chat.messages)) {
				if (!inWindow(c.at, w.start, w.end)) continue;
				practice.problems++;
				if (c.outcome === "solved") practice.solid++;
			}
			continue;
		}
		lessons.allTime++;
		const state = chat.progress.restingState;
		const updated = inWindow(chat.updatedAt, w.start, w.end);
		if (state === "waiting") lessons.waiting++;
		if (updated && state !== "finished") lessons.active++;
		if (updated && state === "finished") lessons.finished++;
	}
	const seen = new Set<string>();
	let added = 0;
	for (const node of input.nodes) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		if (inWindow(node.createdAt, w.start, w.end)) added++;
	}
	return {
		period,
		time: {
			seconds: beatSecondsIn(input.beats, w.start, w.end, true),
			prevSeconds: beatSecondsIn(input.beats, w.prevStart, w.prevEnd),
		},
		lessons,
		ideas: { added, total: seen.size },
		practice,
		tokens: foldUsage(input.usage, w.start, w.end),
	};
}

// ─── topics (the knowledge view) ────────────────────────────────────────────

/** The proposition ids a practice session was started on: its
 *  graph-context marker's picks (message[0] by construction; scanned
 *  anywhere for robustness). */
export function graphContextIdsOf(messages: readonly LhMessage[]): string[] {
	const ids: string[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "custom") continue;
		const marker = m as LhMarkerMessage;
		if (marker.customType !== "graph-context") continue;
		const picks = (marker.details as { propositions?: unknown } | undefined)?.propositions;
		if (!Array.isArray(picks)) continue;
		for (const p of picks) if (typeof (p as { id?: unknown })?.id === "string") ids.push((p as { id: string }).id);
	}
	return ids;
}

/** A notes file's display name: the basename without its extension. */
export function fileTopicName(filePath: string): string {
	const base = filePath.split(/[\\/]/).pop() ?? filePath;
	const dot = base.lastIndexOf(".");
	return (dot > 0 ? base.slice(0, dot) : base) || filePath;
}

export interface TopicsInput {
	/** The snapshot's clusters (birth-session communities; members may
	 *  include derived implication ids — filtered to propositions here). */
	clusters: readonly Cluster[];
	/** Proposition ledger lines (first line per id defines createdAt). */
	propositions: readonly GraphNode[];
	/** chatId → title (snapshot.sessions). */
	sessions: Readonly<Record<string, string>>;
	/** srcId → file path (snapshot.fileSources). */
	fileSources: Readonly<Record<string, string>>;
	/** Practice sessions: updatedAt + their graph-context picks. */
	practice: ReadonlyArray<{ updatedAt: string; pickedIds: readonly string[] }>;
}

/** One topic per snapshot cluster, newest-learned first (null last).
 *  Name: a notes cluster reads its file's basename without extension;
 *  a chat cluster its label, else its birth session's title; else
 *  "Untitled topic" (a deleted birth chat keeps its members unlabeled). */
export function topicsOf(input: TopicsInput): Topic[] {
	const createdAt = new Map<string, string>();
	for (const node of input.propositions) if (!createdAt.has(node.id)) createdAt.set(node.id, node.createdAt);
	const topics = input.clusters.map((cluster): Topic => {
		const ideaIds = cluster.members.filter((id) => createdAt.has(id));
		let lastLearnedAt: string | null = null;
		for (const id of ideaIds) {
			const at = createdAt.get(id)!;
			if (lastLearnedAt === null || at > lastLearnedAt) lastLearnedAt = at;
		}
		const ideas = new Set(ideaIds);
		let lastPracticedAt: string | null = null;
		for (const session of input.practice) {
			if (!session.pickedIds.some((id) => ideas.has(id))) continue;
			if (lastPracticedAt === null || session.updatedAt > lastPracticedAt) lastPracticedAt = session.updatedAt;
		}
		const file = input.fileSources[cluster.id];
		const name = file
			? fileTopicName(file)
			: cluster.id.startsWith("src_") && cluster.label
				? fileTopicName(cluster.label)
				: (cluster.label ?? input.sessions[cluster.id] ?? "Untitled topic");
		return { id: cluster.id, name: name.trim() || "Untitled topic", ideaIds, lastLearnedAt, lastPracticedAt };
	});
	return topics.sort((a, b) => {
		if (a.lastLearnedAt === b.lastLearnedAt) return a.id < b.id ? -1 : 1;
		if (a.lastLearnedAt === null) return 1;
		if (b.lastLearnedAt === null) return -1;
		return a.lastLearnedAt < b.lastLearnedAt ? 1 : -1;
	});
}
