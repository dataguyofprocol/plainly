/**
 * The four confidence levels' colours (v4 rebuild, 2026-10-26): a warm →
 * cool ramp, so "how sure" reads at a glance — guessing in amber through
 * certain in green. One table for the live switch (question dock) and the
 * record (answered card). Old six-stop values map to the nearest level.
 */

import { CONFIDENCE_LEVELS } from "@/src/core";

export const CONFIDENCE_LEVEL_COLORS: Record<number, { ink: string; soft: string }> = {
	25: { ink: "#a2601f", soft: "rgba(214, 145, 66, 0.16)" },
	50: { ink: "#8a6d1c", soft: "rgba(201, 170, 64, 0.18)" },
	75: { ink: "#2f7a6b", soft: "rgba(47, 143, 127, 0.15)" },
	95: { ink: "#21633f", soft: "rgba(33, 99, 63, 0.15)" },
};

/** Pure: the level a confidence value reads as (exact for the four
 *  levels; the nearest level for the old 0/30/50/70/90/100 stops). */
export function nearestLevel(value: number): (typeof CONFIDENCE_LEVELS)[number] {
	let best = CONFIDENCE_LEVELS[0]!;
	for (const l of CONFIDENCE_LEVELS) if (Math.abs(l.value - value) < Math.abs(best.value - value)) best = l;
	return best;
}
