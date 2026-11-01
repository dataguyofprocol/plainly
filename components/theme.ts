"use client";

import { useSyncExternalStore } from "react";
import type { ThemeMode } from "@/src/core";
import { resolveTheme, THEME_STORAGE_KEY, type ResolvedTheme } from "@/components/theme-boot";

export type { ResolvedTheme };

const DARK_QUERY = "(prefers-color-scheme: dark)";

let mode: ThemeMode = "system";
let resolved: ResolvedTheme | null = null;
const listeners = new Set<() => void>();
let mediaBound = false;

function systemDark(): boolean {
	return window.matchMedia(DARK_QUERY).matches;
}

function current(): ResolvedTheme {
	return resolved ?? (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
}

function apply(): void {
	const next = resolveTheme(mode, systemDark());
	if (next === resolved) return;
	resolved = next;
	document.documentElement.dataset.theme = next;
	for (const listener of listeners) listener();
}

export function applyThemeMode(next: ThemeMode): void {
	mode = next;
	try {
		localStorage.setItem(THEME_STORAGE_KEY, next);
	} catch {
		/* storage blocked — the next launch boots on "system" */
	}
	(window as unknown as { lh?: { setTheme?: (m: ThemeMode) => void } }).lh?.setTheme?.(next);
	if (!mediaBound) {
		mediaBound = true;
		window.matchMedia(DARK_QUERY).addEventListener("change", () => {
			if (mode === "system") apply();
		});
	}
	apply();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function useResolvedTheme(): ResolvedTheme {
	return useSyncExternalStore(subscribe, current, () => "light");
}
