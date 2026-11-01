"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { HINT_RUNGS, hintTag, isHintRung, repairMathForDisplay, type ArtifactPartProps } from "@/src/core";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ThinkingBlock } from "@/components/thinking-block";
import { usePopoverDismiss } from "@/components/popover-dismiss";

let nodeNameMapPromise: Promise<Record<string, string>> | null = null;
function nodeNameMap(): Promise<Record<string, string>> {
	nodeNameMapPromise ??= fetch("/api/graph")
		.then((r) => (r.ok ? r.json() : { nodes: [] }))
		.then((g: { nodes?: Array<{ id?: unknown; name?: unknown }> }) =>
			Object.fromEntries(
				(g.nodes ?? [])
					.filter((n) => typeof n.id === "string")
					.map((n) => [n.id as string, typeof n.name === "string" ? (n.name as string) : (n.id as string)]),
			),
		)
		.catch(() => ({}));
	return nodeNameMapPromise;
}

export interface PracticeThinkingData {
	problemCallId: string;
	commit?: boolean;
	text: string;
	hint?: number;
}

export function ProblemCard({ part }: ArtifactPartProps) {
	const input = (part.input ?? {}) as { statement?: string };
	const statement = typeof input.statement === "string" ? input.statement : "";
	return (
		<div data-testid="problem-card" className="pcard lh-card-enter">
			<div className="pcard-h">
				<span className="pcard-o">Problem</span>
			</div>
			<div className="pcard-read">
				<MessageResponse>{repairMathForDisplay(statement)}</MessageResponse>
			</div>
			{part.hints && part.hints.length > 0 && <ProblemHints used={part.hints} />}
		</div>
	);
}

function ProblemHints({ used }: { used: readonly number[] }) {
	return (
		<div className="pcard-hints" data-testid="problem-hints">
			<span className="pcard-hints-l">Hints</span>
			{HINT_RUNGS.map(({ rung, label }) => (
				<span key={rung} className={cn("pcard-hint", used.includes(rung) && "used")}>
					<i aria-hidden="true" />
					{label}
				</span>
			))}
		</div>
	);
}

export const OUTCOME_LABEL: Record<string, string> = {
	solved: "Solved",
	solvedWithHints: "Solved with hints",
	movedOn: "Moved on",
	surrendered: "Surrendered",
	dismissed: "Dismissed",
};

export const OUTCOME_CHIP: Record<string, string> = {
	solved: "pill good",
	solvedWithHints: "pill practice",
	movedOn: "pill muted",
	surrendered: "pill danger",
	dismissed: "pill muted",
};

export function ConcludeCard({ part }: ArtifactPartProps) {
	const input = (part.input ?? {}) as { outcome?: string; verdict?: string; solutionReveal?: string };
	const outcome = typeof input.outcome === "string" ? input.outcome : "";
	const verdict = typeof input.verdict === "string" ? input.verdict : "";
	const reveal =
		typeof part.reveal === "string" ? part.reveal : typeof input.solutionReveal === "string" ? input.solutionReveal : "";

	if (outcome === "dismissed") {
		return (
			<div data-testid="conclude-card" className="pcard-dismissed">
				<Icon name="minus" size="sm" />
				Problem dismissed.
			</div>
		);
	}

	return (
		<div data-testid="conclude-card" className="pcard lh-card-enter">
			<div className="pcard-h">
				<span className="pcard-o">Concluded</span>
				{(OUTCOME_LABEL[outcome] ?? "") !== "" && <span className={OUTCOME_CHIP[outcome] ?? OUTCOME_CHIP.movedOn}>{OUTCOME_LABEL[outcome]}</span>}
			</div>
			{verdict.length > 0 && (
				<div className="pcard-verdict">
					<MessageResponse>{repairMathForDisplay(verdict)}</MessageResponse>
				</div>
			)}
			{reveal.length > 0 && (
				<div className="pcard-sec">
					<span className="pcard-o">Model solution</span>
					<div className="pcard-read">
						<MessageResponse>{repairMathForDisplay(reveal)}</MessageResponse>
					</div>
				</div>
			)}
			<MetadataPopover
				concludeInput={input}
				problemInput={(part.problemInput ?? {}) as { mode?: unknown; target?: unknown }}
			/>
		</div>
	);
}

function MetadataPopover({
	concludeInput,
	problemInput,
}: {
	concludeInput: { outcome?: string; rung?: unknown; missClass?: unknown; retest?: unknown };
	problemInput: { mode?: unknown; target?: unknown };
}) {
	const [open, setOpen] = useState(false);
	const triggerRef = useRef<HTMLButtonElement | null>(null);
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const [names, setNames] = useState<Record<string, string> | null>(null);
	const targets = Array.isArray(problemInput.target)
		? problemInput.target.filter((t): t is string => typeof t === "string")
		: [];
	useEffect(() => {
		if (!open || targets.length === 0 || names) return;
		let alive = true;
		void nodeNameMap().then((m) => {
			if (alive) setNames(m);
		});
		return () => {
			alive = false;
		};
	}, [open, targets.length, names]);

	usePopoverDismiss(rootRef, open, () => setOpen(false));
	// ANY scroll closes it (owner law): capture-phase, so every scroller
	// in the tree counts — the transcript's own scroll included.
	useEffect(() => {
		if (!open) return;
		const close = () => setOpen(false);
		window.addEventListener("scroll", close, { capture: true, passive: true });
		return () => window.removeEventListener("scroll", close, { capture: true });
	}, [open]);

	const mode = typeof problemInput.mode === "string" ? problemInput.mode : "";
	const rung = typeof concludeInput.rung === "string" ? concludeInput.rung : "";
	const miss = typeof concludeInput.missClass === "string" ? concludeInput.missClass : "";
	const retest = typeof concludeInput.retest === "boolean" ? concludeInput.retest : undefined;
	const outcome = typeof concludeInput.outcome === "string" ? concludeInput.outcome : "";
	if (!mode && targets.length === 0 && !rung && !miss && retest === undefined) return null;

	return (
		<div ref={rootRef} className="pcard-meta">
			<button
				type="button"
				data-testid="metadata-toggle"
				ref={triggerRef}
				onClick={() => {
					setOpen((v) => {
						if (v) return false;
						const r = triggerRef.current?.getBoundingClientRect();
						if (r) {
							const left = Math.max(8, Math.min(r.left, window.innerWidth - 328));
							setAnchor({ top: r.bottom + 8, left });
						}
						return true;
					});
				}}
				aria-expanded={open}
				className={cn("mini pcard-mt", open && "on")}
			>
				<Icon name="info" size="sm" />
				Metadata
			</button>
			{open &&
				anchor &&
				createPortal(
					<div className="v4 scope">
					<div
						data-testid="metadata-box"
						style={{ top: anchor.top, left: anchor.left }}
						className="pmeta pop"
					>
						<dl className="stat">
							<div>
								<dt>Mode</dt>
								<dd className="mono">{mode || "—"}</dd>
							</div>
							<div>
								<dt>Targets</dt>
								<dd className="mono">
									{targets.length === 0
										? "untagged"
										: targets.map((t, i) => (
												<span key={t}>
													{i > 0 && ", "}
													{names?.[t] ?? t}
												</span>
											))}
								</dd>
							</div>
							<div>
								<dt>Outcome</dt>
								<dd className="mono">{outcome || "—"}</dd>
							</div>
							<div>
								<dt>Hint rung</dt>
								<dd className="mono">{rung || "none"}</dd>
							</div>
							<div>
								<dt>Miss class</dt>
								<dd className="mono">{miss || "none"}</dd>
							</div>
							<div>
								<dt>Retest</dt>
								<dd className="mono">{retest === undefined ? "—" : retest ? "yes" : "no"}</dd>
							</div>
						</dl>
					</div>
					</div>,
					document.body,
				)}
		</div>
	);
}

export function ThinkingCard({ data }: { data: PracticeThinkingData }) {
	return <ThinkingBlock testId="thinking-card" label="Your thinking" tag={isHintRung(data.hint) ? hintTag(data.hint) : undefined} text={data.text} defaultOpen />;
}
