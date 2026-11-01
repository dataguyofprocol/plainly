"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem, GraphSnapshot } from "@/src/core";

export type SessionState = "working" | "waiting" | "finished" | "paused";

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

export function isPractice(c: Pick<ChatListItem, "kind">): boolean {
	return (c.kind ?? "teach") === "practice";
}

export function sessionState(c: V4Chat): SessionState {
	if (c.state) return c.state;
	if (c.busy) return "working";
	if (c.pendingQuestion || (isPractice(c) && c.pendingProblem)) return "waiting";
	return "paused";
}

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

export function dotColor(c: V4Chat, group: SessionGroupV4["name"]): string {
	if (group === "Waiting on you") return "var(--warn)";
	if (group === "Today" && sessionState(c) !== "finished") return "var(--v-accent)";
	return "var(--faint)";
}

export function fmtDuration(seconds: number): string {
	const m = Math.round(seconds / 60);
	if (m < 60) return `${m}m`;
	return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtTokens(n: number): string {
	if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`;
	if (n >= 1_000) return `${Math.round(n / 1_000)}k`;
	return String(n);
}

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

export function useChats(): V4Chat[] | null {
	const [data, refresh] = useServerJson<{ chats: V4Chat[] }>("/api/chats", [
		"chats-changed",
		"turn-started",
		"turn-settled",
		"compaction-changed",
	]);
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

export const TOPIC_COLORS = ["#2f8f7f", "#4a78b5", "#b07a2e", "#b4566b", "#6f8a3a", "#2c8aa6", "#8a6248", "#5b7f73"] as const;

export function topicColor(id: string): string {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
	return TOPIC_COLORS[h % TOPIC_COLORS.length]!;
}


export function useGraphSnapshot(): GraphSnapshot | null {
	const [data, refresh] = useServerJson<GraphSnapshot>("/api/graph", ["activity-changed"]);
	useEffect(() => {
		window.addEventListener("lh:graph-revision", refresh);
		return () => window.removeEventListener("lh:graph-revision", refresh);
	}, [refresh]);
	return data;
}

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
