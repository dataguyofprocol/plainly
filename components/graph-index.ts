"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { GraphSnapshot } from "@/src/core";

export interface IndexedIdea {
	id: string;
	name: string;
	statement: string;
	createdAt: string;
	source: string | null;
}

export function indexIdeas(snapshot: Pick<GraphSnapshot, "propositions" | "sessions" | "fileSources">): IndexedIdea[] {
	return snapshot.propositions
		.map((n) => {
			const first = n.provenance[0]?.chatId;
			const source = first ? (snapshot.sessions[first] ?? snapshot.fileSources[first] ?? null) : null;
			return { id: n.id, name: n.name, statement: n.statement, createdAt: n.createdAt, source };
		})
		.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function useGraphIndex(): IndexedIdea[] | null {
	const [ideas, setIdeas] = useState<IndexedIdea[] | null>(null);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/graph", { cache: "no-store" });
			if (!res.ok) return;
			setIdeas(indexIdeas((await res.json()) as GraphSnapshot));
		} catch {
			// a transient failure keeps the last list
		}
	}, []);

	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = useCallback(() => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => void refresh(), 250);
	}, [refresh]);

	useServerEvent("activity-changed", schedule);
	useServerResync(() => void refresh());
	useEffect(() => {
		void refresh();
		window.addEventListener("lh:graph-revision", schedule);
		return () => {
			window.removeEventListener("lh:graph-revision", schedule);
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [refresh, schedule]);

	return ideas;
}
