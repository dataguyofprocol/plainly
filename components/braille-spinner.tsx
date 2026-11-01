import { cn } from "@/lib/utils";

const FRAMES: ReadonlyArray<{ dots: ReadonlyArray<readonly [number, number]> }> = [
	{ dots: [[1, 1], [1, 3], [3, 1]] },
	{ dots: [[1, 1], [3, 1], [3, 3]] },
	{ dots: [[1, 1], [3, 1], [3, 3], [3, 5]] },
	{ dots: [[3, 1], [3, 3], [3, 5]] },
	{ dots: [[1, 5], [3, 1], [3, 3], [3, 5]] },
	{ dots: [[1, 5], [3, 3], [3, 5]] },
	{ dots: [[1, 3], [1, 5], [3, 5]] },
	{ dots: [[1, 1], [1, 3], [1, 5], [3, 5]] },
	{ dots: [[1, 1], [1, 3], [1, 5]] },
	{ dots: [[1, 1], [1, 3], [1, 5], [3, 1]] },
];

export const SPINNER_FRAME_MS = 80;
export const SPINNER_FRAMES = FRAMES.length;

export function BrailleSpinner({
	className,
	label = "Working",
}: {
	className?: string;
	label?: string;
}) {
	return (
		<svg
			viewBox="0 0 4 8"
			data-testid="braille-spinner"
			role="status"
			aria-label={label}
			className={cn("h-3 w-auto shrink-0 text-foreground", className)}
		>
			{FRAMES.map((frame, k) => (
				<g
					key={k}
					className="braille-frame"
					data-frame={k}
					style={{ animationDelay: `${k * SPINNER_FRAME_MS}ms` }}
				>
					{frame.dots.map(([cx, cy]) => (
						<circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={0.8} className="fill-current" />
					))}
				</g>
			))}
		</svg>
	);
}
