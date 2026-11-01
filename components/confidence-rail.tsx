import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";
import { CONFIDENCE_LEVEL_COLORS } from "@/components/confidence-colors";
import { CONFIDENCE_LEVELS, CONFIDENCE_STOPS } from "@/src/core";

export const CONFIDENCE_COLORS: readonly string[] = [
	"#ef4444", // 0
	"#f97316", // 30
	"#eab308", // 50
	"#84cc16", // 70
	"#22c55e", // 90
	"#10b981", // 100
];

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
