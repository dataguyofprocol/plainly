"use client";

/**
 * THE V4 DATA HOOKS (rebuild, 2026-10-26): one place where the screens read
 * the server — the session list (enriched with state, plan position, the
 * pending question's text, minutes), the learning stats, the week's minutes
 * and the graph suggestions. Every hook refreshes on the server events that
 * can change its answer; none polls.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem, GraphSnapshot } from "@/src/core";

// ─── Contract shapes (src/core carries the canonical types) ────────────────

export type SessionState = "working" | "waiting" | "finished" | "paused";

/** The session list item as the v4 screens read it: the base list item plus
 *  the enrichment the server adds. Every enriched field is optional so a
 *  server without it still renders (the fallbacks live in the helpers). */
export type V4Chat = ChatListItem & {
	state?: SessionState;
	pendingQuestionText?: string | null;
	plan?: { total: number; visited: number; current: number | null } | null;
	minutes?: number;
	answers?: { total: number; firstTry: number } | null;
	practiceSet?: { size: number; done: number } | null;
};

export type StatsPeriod = "week" | "month";

export interface V4Stats {
	period: StatsPeriod;
	time: { seconds: number; prevSeconds: number };
	lessons: { active: number; waiting: number; finished: number; allTime: number };
	ideas: { added: number; total: number };
	practice: { problems: number; solid: number };
	tokens: { total: number; dollars: number | null };
}

export interface V4Daily {
	goalMinutes: number;
	days: Array<{ date: string; label: string; minutes: number; today: boolean }>;
	metDays: number;
}

export interface V4Suggestion {
	title: string;
	reason: string;
}

// ─── Pure helpers (tested) ─────────────────────────────────────────────────

export function isPractice(c: Pick<ChatListItem, "kind">): boolean {
	return (c.kind ?? "teach") === "practice";
}

/** The session's state: the server's when it sends one, else derived from
 *  the base list fields (a turn running, something waiting, or paused). */
export function sessionState(c: V4Chat): SessionState {
	if (c.state) return c.state;
	if (c.busy) return "working";
	if (c.pendingQuestion || (isPractice(c) && c.pendingProblem)) return "waiting";
	return "paused";
}

/** Compact "how long ago" in the design's register: "just now", "18 min
 *  ago", "3 h ago", "yesterday", "3 days ago", then the ISO date. */
export function ago(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min} min ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h} h ago`;
	const d = Math.floor(h / 24);
	if (d === 1) return "yesterday";
	if (d < 7) return `${d} days ago`;
	const date = new Date(iso);
	return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** The sidebar row's second line (Home4): where the session stands. */
export function sessionLine(c: V4Chat, now = new Date()): string {
	const state = sessionState(c);
	if (c.compacting) return "Compacting context";
	if (state === "working") return "Working…";
	if (isPractice(c)) {
		const set = c.practiceSet;
		if (state === "finished") return `Set done · ${ago(c.updatedAt, now)}`;
		if (set) return `Practice · ${Math.min(set.done + 1, set.size)} of ${set.size}`;
		return state === "waiting" ? "Practice · problem waiting" : `Practice · ${ago(c.updatedAt, now)}`;
	}
	if (state === "finished") return `Finished · ${ago(c.updatedAt, now)}`;
	if (state === "waiting") {
		if (c.plan && c.plan.current !== null) return `Step ${c.plan.current} of ${c.plan.total}`;
		return "Check-in";
	}
	return `Paused · ${ago(c.updatedAt, now)}`;
}

export interface SessionGroupV4 {
	name: "Waiting on you" | "Today" | "Earlier" | "Archived";
	chats: V4Chat[];
}

/** The sidebar groups (Home4): what waits on you, today's, the rest — and,
 *  last, what the learner archived (out of the live groups, restorable). */
export function groupChats(chats: readonly V4Chat[], now = new Date()): SessionGroupV4[] {
	const start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const groups: SessionGroupV4[] = [
		{ name: "Waiting on you", chats: [] },
		{ name: "Today", chats: [] },
		{ name: "Earlier", chats: [] },
		{ name: "Archived", chats: [] },
	];
	for (const c of chats) {
		if (c.archived) groups[3]!.chats.push(c);
		else if (sessionState(c) === "waiting") groups[0]!.chats.push(c);
		else if (new Date(c.updatedAt).getTime() >= start) groups[1]!.chats.push(c);
		else groups[2]!.chats.push(c);
	}
	return groups.filter((g) => g.chats.length > 0);
}

/** The row dot's colour: waiting = warn, today's live work = accent, else faint. */
export function dotColor(c: V4Chat, group: SessionGroupV4["name"]): string {
	if (group === "Waiting on you") return "var(--warn)";
	if (group === "Today" && sessionState(c) !== "finished") return "var(--v-accent)";
	return "var(--faint)";
}

/** "4h 12m", "38m", "0m". */
export function fmtDuration(seconds: number): string {
	const m = Math.round(seconds / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** "1.24M", "212k", "940". */
export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

// ─── Hooks ─────────────────────────────────────────────────────────────────

/** A fetch that refreshes on the given server events (250ms trailing
 *  debounce — the sidebar's law) and on channel resync. */
function useServerJson<T>(url: string | null, events: Parameters<typeof useServerEvent>[0][]): [T | null, () => void] {
	const [data, setData] = useState<T | null>(null);
	const refresh = useCallback(() => {
		if (!url) return;
		fetch(url, { cache: "no-store" })
			.then((r) => (r.ok ? (r.json() as Promise<T>) : null))
			.then((d) => d !== null && setData(d))
			.catch(() => {});
	}, [url]);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = useCallback(() => {
		if (timer.current) clearTimeout(timer.current);
		timer.current = setTimeout(refresh, 250);
	}, [refresh]);
	// Hooks are never conditional: subscribe to every type, act on the listed.
	const on = (type: Parameters<typeof useServerEvent>[0]) => () => {
		if (events.includes(type)) schedule();
	};
	useServerEvent("turn-settled", on("turn-settled"));
	useServerEvent("turn-started", on("turn-started"));
	useServerEvent("chats-changed", on("chats-changed"));
	useServerEvent("activity-changed", on("activity-changed"));
	useServerEvent("jobs-changed", on("jobs-changed"));
	useServerEvent("compaction-changed", on("compaction-changed"));
	useServerResync(refresh);
	useEffect(() => {
		refresh();
		return () => {
			if (timer.current) clearTimeout(timer.current);
		};
	}, [refresh]);
	return [data, refresh];
}

/** The session list, live. */
export function useChats(): V4Chat[] | null {
	const [data, refresh] = useServerJson<{ chats: V4Chat[] }>("/api/chats", [
		"chats-changed",
		"turn-started",
		"turn-settled",
		"compaction-changed",
	]);
	// Same-tab instants: a rename lands before any round trip.
	useEffect(() => {
		const on = () => refresh();
		window.addEventListener("lh:chat-renamed", on);
		window.addEventListener("lh:turn-state", on);
		return () => {
			window.removeEventListener("lh:chat-renamed", on);
			window.removeEventListener("lh:turn-state", on);
		};
	}, [refresh]);
	return data?.chats ?? null;
}

export function useStats(period: StatsPeriod): V4Stats | null {
	const [data] = useServerJson<V4Stats>(`/api/stats?period=${period}`, ["turn-settled", "activity-changed", "chats-changed"]);
	return data;
}

export function useDaily(): V4Daily | null {
	const [data] = useServerJson<V4Daily>("/api/stats/daily", ["turn-settled", "activity-changed"]);
	return data;
}

export function useSuggestions(): V4Suggestion[] {
	const [data] = useServerJson<{ suggestions: V4Suggestion[] }>("/api/suggestions", ["activity-changed"]);
	return data?.suggestions ?? [];
}

// ─── Topics (graph clusters) ───────────────────────────────────────────────

export interface V4Topic {
	id: string;
	name: string;
	ideaIds: string[];
	lastLearnedAt: string | null;
	lastPracticedAt: string | null;
}

export function useTopics(): V4Topic[] | null {
	const [data] = useServerJson<{ topics: V4Topic[] }>("/api/topics", ["activity-changed", "chats-changed"]);
	return data?.topics ?? null;
}

/** The design's topic palette (Knowledge4), assigned by a stable hash of
 *  the topic id so a topic keeps its colour everywhere it appears. */
export const TOPIC_COLORS = ["#2f8f7f", "#4a78b5", "#b07a2e", "#b4566b", "#6f8a3a", "#2c8aa6", "#8a6248", "#5b7f73"] as const;

export function topicColor(id: string): string {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
	return TOPIC_COLORS[h % TOPIC_COLORS.length]!;
}

// ─── The graph snapshot (Knowledge) ────────────────────────────────────────


/** The full snapshot, live: refetched on extraction phase changes and on
 *  the local lh:graph-revision announcement (deletions). */
export function useGraphSnapshot(): GraphSnapshot | null {
	const [data, refresh] = useServerJson<GraphSnapshot>("/api/graph", ["activity-changed"]);
	useEffect(() => {
		window.addEventListener("lh:graph-revision", refresh);
		return () => window.removeEventListener("lh:graph-revision", refresh);
	}, [refresh]);
	return data;
}

/** Pure: the ids to light up for a selected idea — two hops up (through
 *  the chain's implication node to its premises) and two hops down (to
 *  what it leads to), over the drawn edges. Exported for tests. */
export function chainNeighbourhood(edges: ReadonlyArray<{ from: string; to: string }>, selected: string, hops = 2): Set<string> {
	const ids = new Set([selected]);
	let up = new Set([selected]);
	let down = new Set([selected]);
	for (let i = 0; i < hops; i++) {
		const nextUp = new Set<string>();
		const nextDown = new Set<string>();
		for (const e of edges) {
			if (up.has(e.to) && !ids.has(e.from)) nextUp.add(e.from);
			if (down.has(e.from) && !ids.has(e.to)) nextDown.add(e.to);
		}
		for (const id of nextUp) ids.add(id);
		for (const id of nextDown) ids.add(id);
		up = nextUp;
		down = nextDown;
	}
	return ids;
}
