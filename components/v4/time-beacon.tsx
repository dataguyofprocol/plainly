"use client";

/**
 * THE ACTIVE-TIME BEACON (v4 rebuild, 2026-10-26): what "time learning"
 * means — a lesson or practice session is on screen, the window is
 * visible, and the learner did something (key, pointer, scroll, dictation)
 * in the last two minutes. Every 30s that holds, one beat of the elapsed
 * seconds goes to POST /api/activity/time; the server clamps and ledgers
 * it. Nothing else is measured, and nothing leaves the machine.
 */

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const BEAT_MS = 30_000;
const IDLE_MS = 120_000;

/** Pure: the chat a path belongs to, or null (drafts and pages don't count). */
export function beaconChatId(pathname: string | null): string | null {
	const m = pathname?.match(/^\/chat\/([^/?#]+)$/);
	return m && m[1] !== "new" ? decodeURIComponent(m[1]!) : null;
}

/** Pure: the seconds a beat may claim — the time since the last beat,
 *  only while the learner was recently active. */
export function beatSeconds(now: number, lastBeat: number, lastActivity: number): number {
	if (now - lastActivity > IDLE_MS) return 0;
	return Math.max(0, Math.min(60, Math.round((now - lastBeat) / 1000)));
}

export function TimeBeacon() {
	const chatId = beaconChatId(usePathname());
	const lastActivity = useRef(Date.now());

	useEffect(() => {
		const mark = () => {
			lastActivity.current = Date.now();
		};
		const events = ["keydown", "pointerdown", "pointermove", "wheel", "lh:dictation-final"] as const;
		for (const e of events) window.addEventListener(e, mark, { passive: true });
		return () => {
			for (const e of events) window.removeEventListener(e, mark);
		};
	}, []);

	useEffect(() => {
		if (!chatId) return;
		let lastBeat = Date.now();
		const send = () => {
			const now = Date.now();
			const visible = document.visibilityState === "visible";
			const seconds = visible ? beatSeconds(now, lastBeat, lastActivity.current) : 0;
			lastBeat = now;
			if (seconds <= 0) return;
			void fetch("/api/activity/time", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ chatId, seconds }),
				keepalive: true,
			}).catch(() => {});
		};
		const timer = setInterval(send, BEAT_MS);
		// Leaving the session flushes the partial beat.
		return () => {
			clearInterval(timer);
			send();
		};
	}, [chatId]);

	return null;
}
