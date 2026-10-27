/**
 * The theme's pure half (dark mode wave, owner 2026-10-27): the mode →
 * palette resolution, and the pre-paint boot script run against a stub
 * page — the script is a string the server inlines, so it is exercised
 * exactly as shipped.
 */
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { describe, it } from "node:test";
import { resolveTheme, THEME_BOOT_SCRIPT, THEME_STORAGE_KEY } from "../components/theme-boot.ts";

describe("resolveTheme", () => {
	it("system follows the OS; light and dark pin", () => {
		assert.equal(resolveTheme("system", true), "dark");
		assert.equal(resolveTheme("system", false), "light");
		assert.equal(resolveTheme("light", true), "light");
		assert.equal(resolveTheme("dark", false), "dark");
	});
});

describe("THEME_BOOT_SCRIPT", () => {
	/** Run the script on a stub page; `stored` undefined = nothing saved,
	 *  "throw" = storage blocked. Returns the data-theme it set. */
	function boot(stored: string | undefined | "throw", systemDark: boolean): string | undefined {
		const dataset: Record<string, string> = {};
		const localStorage = {
			getItem(key: string) {
				if (stored === "throw") throw new Error("blocked");
				return key === THEME_STORAGE_KEY ? (stored ?? null) : null;
			},
		};
		const window = { matchMedia: (q: string) => ({ matches: q === "(prefers-color-scheme: dark)" && systemDark }) };
		runInNewContext(THEME_BOOT_SCRIPT, { localStorage, window, document: { documentElement: { dataset } } });
		return dataset.theme;
	}

	it("a pinned mode wins over the OS", () => {
		assert.equal(boot("dark", false), "dark");
		assert.equal(boot("light", true), "light");
	});

	it("system, nothing saved, junk, or blocked storage all follow the OS", () => {
		for (const stored of ["system", undefined, "sepia", "throw"] as const) {
			assert.equal(boot(stored, true), "dark", String(stored));
			assert.equal(boot(stored, false), "light", String(stored));
		}
	});
});
