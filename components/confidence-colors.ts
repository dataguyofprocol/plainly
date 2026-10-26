/**
 * The four confidence levels' colours (v4 rebuild, 2026-10-26): a warm →
 * cool ramp, so "how sure" reads at a glance — guessing in amber through
 * certain in green. One table for the live switch (question dock) and the
 * record (answered card). Old six-stop values map to the nearest level.
 * The values are tokens (app/globals.css --conf-1..4), so a theme owns them.
 */

import { CONFIDENCE_LEVELS } from "@/src/core";

export const CONFIDENCE_LEVEL_COLORS: Record<number, { ink: string; soft: string }> = {
	25: { ink: "var(--conf-1)", soft: "var(--conf-1-soft)" },
	50: { ink: "var(--conf-2)", soft: "var(--conf-2-soft)" },
	75: { ink: "var(--conf-3)", soft: "var(--conf-3-soft)" },
	95: { ink: "var(--conf-4)", soft: "var(--conf-4-soft)" },
};

/** Pure: the level a confidence value reads as (exact for the four
 *  levels; the nearest level for the old 0/30/50/70/90/100 stops). */
export function nearestLevel(value: number): (typeof CONFIDENCE_LEVELS)[number] {
	let best = CONFIDENCE_LEVELS[0]!;
	for (const l of CONFIDENCE_LEVELS) if (Math.abs(l.value - value) < Math.abs(best.value - value)) best = l;
	return best;
}
