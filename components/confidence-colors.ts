import { CONFIDENCE_LEVELS } from "@/src/core";

export const CONFIDENCE_LEVEL_COLORS: Record<number, { ink: string; soft: string }> = {
	25: { ink: "var(--conf-1)", soft: "var(--conf-1-soft)" },
	50: { ink: "var(--conf-2)", soft: "var(--conf-2-soft)" },
	75: { ink: "var(--conf-3)", soft: "var(--conf-3-soft)" },
	95: { ink: "var(--conf-4)", soft: "var(--conf-4-soft)" },
};

export function nearestLevel(value: number): (typeof CONFIDENCE_LEVELS)[number] {
	let best = CONFIDENCE_LEVELS[0]!;
	for (const l of CONFIDENCE_LEVELS) if (Math.abs(l.value - value) < Math.abs(best.value - value)) best = l;
	return best;
}
