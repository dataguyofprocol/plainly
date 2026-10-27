"use client";

/**
 * THE THEME (dark mode wave, owner 2026-10-27): which palette block of
 * app/globals.css is live — `data-theme="light" | "dark"` on <html>.
 *
 * Truth vs. mirror (owner ruling): the setting lives in settings.json
 * (appearance.mode — "system" | "light" | "dark", factory "system"); the
 * app MIRRORS it into localStorage so THEME_BOOT_SCRIPT can paint the
 * right palette before React or the settings fetch exist. A hand edit of
 * settings.json shows the old theme for a moment, until the record loads.
 *
 * Order law: applyThemeMode sets the attribute FIRST and notifies after,
 * so a subscriber that re-renders on the switch (the graph's colors,
 * mermaid charts) reads the NEW token values in its effects.
 *
 * The desktop shell is told too (window.lh.setTheme): it drives
 * nativeTheme, so the window background and the OS chrome match.
 */
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
	// Before the first applyThemeMode the boot script's attribute is the truth.
	return resolved ?? (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
}

function apply(): void {
	const next = resolveTheme(mode, systemDark());
	if (next === resolved) return;
	resolved = next;
	document.documentElement.dataset.theme = next;
	for (const listener of listeners) listener();
}

/** Set the user's mode: palette, mirror, and the desktop shell. */
export function applyThemeMode(next: ThemeMode): void {
	mode = next;
	try {
		localStorage.setItem(THEME_STORAGE_KEY, next);
	} catch {
		/* storage blocked — the next launch boots on "system" */
	}
	(window as unknown as { lh?: { setTheme?: (m: ThemeMode) => void } }).lh?.setTheme?.(next);
	if (!mediaBound) {
		// One listener for the app's life: "system" follows the OS live.
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

/** The live palette. Server render reports light; the client corrects on
 *  hydration. Consumers that paint from tokens in JS (canvas, mermaid)
 *  put this in their effect deps to redraw on a switch. */
export function useResolvedTheme(): ResolvedTheme {
	return useSyncExternalStore(subscribe, current, () => "light");
}
