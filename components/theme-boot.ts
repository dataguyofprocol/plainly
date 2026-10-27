/**
 * The theme's server-safe half (no "use client": app/layout.tsx is a
 * server component and inlines THEME_BOOT_SCRIPT, which must arrive as
 * the string itself, not a client reference). The live store is
 * components/theme.ts.
 */
import type { ThemeMode } from "@/src/core";

export type ResolvedTheme = "light" | "dark";

/** The localStorage mirror's key. */
export const THEME_STORAGE_KEY = "lh-theme";

/** Pure: the palette a mode resolves to. Exported for tests. */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): ResolvedTheme {
	if (mode === "system") return systemDark ? "dark" : "light";
	return mode;
}

/** Inlined in <head> (app/layout.tsx): runs before first paint. Any
 *  unreadable mirror (absent, junk, storage blocked) means "system". */
export const THEME_BOOT_SCRIPT = `(function(){var m="system";try{var s=localStorage.getItem(${JSON.stringify(THEME_STORAGE_KEY)});if(s==="light"||s==="dark")m=s}catch(e){}var d=m==="dark"||(m==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);document.documentElement.dataset.theme=d?"dark":"light"})()`;
