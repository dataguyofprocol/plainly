"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

const BEAT_MS = 30_000;
const IDLE_MS = 120_000;

export function beaconChatId(pathname: string | null): string | null {
	const m = pathname?.match(/^\/chat\/([^/?#]+)$/);
	return m && m[1] !== "new" ? decodeURIComponent(m[1]!) : null;
}

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
		return () => {
			clearInterval(timer);
			send();
		};
	}, [chatId]);

	return null;
}
