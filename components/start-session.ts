"use client";

import { useCallback, useEffect, useState } from "react";
import { useStrongKeyless, useZeroKeys } from "@/components/setup-cta";
import { useSettingsSaved } from "@/components/settings-signal";
import { slotsConfigured, withAttachments, type ModelsSettings } from "@/src/core";

export type StartMode = "teach" | "practice";
export type StartPick = { id: string; name: string; statement: string };

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
		configured,
		zeroKeys,
		ready: configured === true && !zeroKeys && !strongKeyless,
		markConfigured: () => setConfigured(true),
	};
}

export async function createSession(
	text: string,
	mode: StartMode,
	picks: readonly StartPick[] = [],
	attachments: readonly string[] = [],
): Promise<string> {
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
	return `/chat/${id}?prompt=${encodeURIComponent(withAttachments(t, attachments))}`;
}
