import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { CONFIDENCE_LEVEL_COLORS } from "@/components/confidence-colors";
import { CONFIDENCE_LEVELS, CONFIDENCE_STOPS } from "@/src/core";

/**
 * The confidence RAIL — the slider's paint, shared by two surfaces so they
 * can never drift apart (owner, 2026-10-01):
 *
 *   - the dock's live slider (question-dock) — a transparent range input
 *     rides on top of this paint, disc and all;
 *   - the ANSWERED card (owner round 6) — the same rail with NO disc,
 *     which itself communicates "this is a record, not a control".
 *
 * Geometry law: the rail spans the thumb-CENTER range (inset half a 16px
 * disc per side) so the dock's 0/100 stops sit flush at the very ends.
 * The static card has no thumb, but keeps the identical shape.
 *
 * Stack law: the muted surface as base, SOLID stop ticks
 * as background layers UNDER the fill, and the fill itself TRANSPARENT
 * past the value — so ticks show only on the empty side, never over the
 * color. Ticks skip 0 and 100 (the rail's ends already say those).
 */

/** The six-step ramp (owner ruling): 0 red → 100 emerald, indexed by stop. */
export const CONFIDENCE_COLORS: readonly string[] = [
	"#ef4444", // 0
	"#f97316", // 30
	"#eab308", // 50
	"#84cc16", // 70
	"#22c55e", // 90
	"#10b981", // 100
];

/** The rail's paint for a stop value (0–100). */
export function confidenceRailStyle(value: number): CSSProperties {
	const color = CONFIDENCE_COLORS[CONFIDENCE_STOPS.indexOf(value)] ?? CONFIDENCE_COLORS[2]!;
	return {
		backgroundColor: "var(--muted)",
		backgroundImage: [
			`linear-gradient(90deg, ${color} 0%, ${color} ${value}%, transparent ${value}%, transparent 100%)`,
			...[30, 50, 70, 90].map(
				() => "linear-gradient(90deg, var(--input), var(--input))",
			),
		].join(", "),
		backgroundSize: ["100% 100%", "1px 100%", "1px 100%", "1px 100%", "1px 100%"].join(", "),
		backgroundPosition: ["0 0", ...[30, 50, 70, 90].map((p) => `${p}% 0`)].join(", "),
		backgroundRepeat: "no-repeat",
	};
}

/** The static rail — the slider's look, disc removed. */
export function ConfidenceRail({ value, className }: { value: number; className?: string }) {
	return (
		<div
			aria-hidden
			data-testid="confidence-rail"
			className={cn("h-1.5 w-full rounded-full border border-border", className)}
			style={confidenceRailStyle(value)}
		/>
	);
}

/**
 * HOW SURE (owner, 2026-10-27: the compact switch) — "How sure are you?"
 * as one slim four-way switch, shared by the question dock and the
 * practice dock so the two can never drift. The chosen level is a white
 * chip whose text wears that level's colour (confidence-colors.ts, passed
 * as --lvl). `value` is a level value (25/50/75/95) or null when nothing
 * is chosen yet.
 */
export function ConfidenceLadder({
	value,
	onChange,
	disabled = false,
	labelledBy,
	title,
	testid,
	stopTestids = false,
}: {
	value: number | null;
	onChange: (value: number) => void;
	disabled?: boolean;
	labelledBy: string;
	title?: string;
	testid?: string;
	/** The question dock's per-rung testids (confidence-stop-<value>). */
	stopTestids?: boolean;
}) {
	const at = value === null || disabled ? -1 : CONFIDENCE_LEVELS.findIndex((l) => l.value === value);
	return (
		<div
			className={cn("conf", disabled && "off")}
			role="radiogroup"
			aria-labelledby={labelledBy}
			aria-disabled={disabled}
			title={title}
			data-testid={testid}
		>
			{CONFIDENCE_LEVELS.map((level, i) => {
				const c = CONFIDENCE_LEVEL_COLORS[level.value]!;
				return (
					<button
						key={level.value}
						type="button"
						role="radio"
						aria-checked={i === at}
						disabled={disabled}
						onClick={() => onChange(level.value)}
						data-testid={stopTestids ? `confidence-stop-${level.value}` : undefined}
						className={cn(i === at && "on")}
						style={{ "--lvl": c.ink, "--lvl-soft": c.soft } as CSSProperties}
					>
						{level.label}
					</button>
				);
			})}
		</div>
	);
}
