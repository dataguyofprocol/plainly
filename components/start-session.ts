"use client";

/**
 * STARTING A SESSION (v4 redesign, 2026-10-26) — one seam for the home
 * omnibar and the ⌘K palette, so both start sessions the same way the
 * graph composer always did:
 *
 *   - THE PRE-SEND GUARDS (owner interlude, no-orphan-chats): models not
 *     configured, no provider key, or the strong slot's provider keyless →
 *     the caller opens setup INSTEAD of creating. The server's 503 lands
 *     only after POST /api/chats has created the record, so a refused
 *     first send would leave an orphan chat in the sidebar.
 *   - The create carries the title (= the learner's words), the kind, and
 *     any proposition picks as graphContext; the push target's ?prompt
 *     delivers the words as turn 1 (chat/[id] initialPrompt).
 */

import { useCallback, useEffect, useState } from "react";
import { useStrongKeyless, useZeroKeys } from "@/components/setup-cta";
import { useSettingsSaved } from "@/components/settings-signal";
import { slotsConfigured, type ModelsSettings } from "@/src/core";

export type StartMode = "teach" | "practice";
export type StartPick = { id: string; name: string; statement: string };

/** Whether a session may be created right now. `configured` is seeded by
 *  server-rendered pages and otherwise read once; every models write
 *  re-reads it (the settings signal), like the chat page's CTA. */
export function useStartReadiness(initialConfigured?: boolean) {
	const [configured, setConfigured] = useState<boolean | null>(initialConfigured ?? null);
	const zeroKeys = useZeroKeys();
	const strongKeyless = useStrongKeyless();
	const reread = useCallback(() => {
		fetch("/api/settings")
			.then((r) => r.json() as Promise<{ settings?: { models?: ModelsSettings } | null } | null>)
			.then((body) => setConfigured(slotsConfigured(body?.settings?.models)))
			.catch(() => {});
	}, []);
	useEffect(() => {
		if (initialConfigured === undefined) reread();
	}, [initialConfigured, reread]);
	useSettingsSaved((section) => {
		if (section === "models") reread();
	});
	return {
		/** Null until known — callers treat unknown as "ask setup" only on
		 *  an explicit start, never as a CTA flash on load. */
		configured,
		zeroKeys,
		ready: configured === true && !zeroKeys && !strongKeyless,
		markConfigured: () => setConfigured(true),
	};
}

/** Create the session and return the push target. Throws on a refused
 *  create (the caller resets its busy state). */
export async function createSession(text: string, mode: StartMode, picks: readonly StartPick[] = []): Promise<string> {
	const t = text.trim();
	const res = await fetch("/api/chats", {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			title: t,
			...(mode === "practice" ? { kind: "practice" } : {}),
			...(picks.length > 0 ? { graphContext: { propositions: picks } } : {}),
		}),
	});
	if (!res.ok) throw new Error(`create failed: ${res.status}`);
	const { id } = (await res.json()) as { id: string };
	return `/chat/${id}?prompt=${encodeURIComponent(t)}`;
}
