import type { Phase3 } from "@/src/core";
import { Icon } from "@/components/ui/icon";

const CHIP_LABEL: Record<Phase3, string> = {
	probe: "Probing",
	plan: "Planning",
	teach: "Teaching",
};

export function PhaseChip({ phase }: { phase: Phase3 }) {
	return (
		<span
			data-testid="phase-chip"
			data-phase={phase}
			aria-hidden="true"
			className="pointer-events-none flex shrink-0 select-none items-center text-xs font-medium text-muted-foreground"
		>
			{CHIP_LABEL[phase]}
		</span>
	);
}

export function PhaseDivider({ phase, nodeCount }: { phase: Phase3; nodeCount?: number }) {
	if (phase === "probe") return null;
	const label =
		phase === "plan" && nodeCount
			? `Plan · ${nodeCount} node${nodeCount === 1 ? "" : "s"}`
			: CHIP_LABEL[phase];
	return (
		<div className="ls-divider" data-testid={`phase-divider-${phase}`}>
			<i aria-hidden />
			<span>
				<Icon name={phase === "plan" ? "plan" : "learn"} size="xs" />
				{label}
			</span>
			<i aria-hidden />
		</div>
	);
}

export function planNodeCount(
	message: { parts: ReadonlyArray<{ type: string; state?: string; output?: unknown; [k: string]: unknown }> },
): number | undefined {
	for (const part of message.parts) {
		if (!part.type.startsWith("tool-plan_") || part.state !== "output-available") continue;
		const tree = (part.output as { tree?: { nodes?: unknown[] } } | undefined)?.tree;
		if (tree && Array.isArray(tree.nodes) && tree.nodes.length > 0) return tree.nodes.length;
	}
	return undefined;
}
