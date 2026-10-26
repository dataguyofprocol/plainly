"use client";

import { MessageResponse } from "@/components/ai-elements/message";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { HINT_RUNGS, hintTag, isHintRung, repairMathForDisplay, type ArtifactPartProps } from "@/src/core";

/**
 * The practice transcript cards (practice sessions, owner design
 * 2026-10-04): three quiet records in the stream —
 *
 * - ProblemCard — a posed problem: the statement, compact-expandable
 *   (like every card here; the dock is the working surface, this is the
 *   record). The commitment NEVER renders — only the call's statement.
 * - ConcludeCard — the conclusion: outcome badge + verdict + the reveal
 *   (the committed solution, shown when the problem ended). A dismissal
 *   synthesis (outcome:"dismissed") renders as one muted line.
 * - ThinkingCard — the learner's own submission, user-side: the register
 *   is the two buttons' (Nudge = working trace, Commit = answer). The
 *   UNIFIED ThinkingBlock (owner round 2026-10-05): the quiz quote-block
 *   language in a faint user-side shell, never collapsible.
 */

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ThinkingBlock } from "@/components/thinking-block";
import { usePopoverDismiss } from "@/components/popover-dismiss";

/* TARGET NAMES (owner round 17, 2026-10-06): targets are normalized to
 * opaque node ids at the record seam (owner round 9 — the mastery trace
 * groups on them), so the drawer resolves names at render time. One
 * lazy module-cached fetch of the graph view (the id → name map is a
 * few KB); failures degrade to raw ids — observability never breaks the
 * card. */
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

/** The practice-thinking marker's details (native-messages.ts). */
export interface PracticeThinkingData {
	problemCallId: string;
	/** Legacy records (pre 2026-10-05) carry the old two-lane flag; ignored. */
	commit?: boolean;
	text: string;
	/** The hint rung when the submission was a hint request (1 | 2 | 3). */
	hint?: number;
}

export function ProblemCard({ part }: ArtifactPartProps) {
	// Always open, no chevron (owner round, 2026-10-05): the record IS the
	// statement — same container + eyebrow discipline as the answered card
	// and the dock (which mirrors this in Slice D). The commitment never
	// renders — only the call's statement.
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

/** The problem card's hint footer (owner, 2026-10-27): the hints live in
 *  the practice panel; the transcript keeps only which rungs were used. */
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

/* The outcome pills (owner round 3, 2026-10-05; v4 pills in the finesse
 * pass): the same register as the answered cards' verdicts. Solved reads
 * green (the "correct" twin), solved-with-hints wears Practice's warm mark
 * (succeeded with cost), surrendered red (the problem beat the learner),
 * moved on muted (the agent's call, not a verdict against him). */
export const OUTCOME_CHIP: Record<string, string> = {
	solved: "pill good",
	solvedWithHints: "pill practice",
	movedOn: "pill muted",
	surrendered: "pill danger",
	dismissed: "pill muted",
};

export function ConcludeCard({ part }: ArtifactPartProps) {
	// The conclusion redesigned (owner round, 2026-10-05): the SOLUTION is
	// the hero — the modelSolution committed at pose time (part.reveal, the
	// view-seam join), shown verbatim, never re-authored. The verdict sits
	// below in the quiz-explanation register (small, muted, low-key).
	// Nothing collapsible. Legacy inputs (pre-slim records) that carry
	// their own solutionReveal fall back to it.
	const input = (part.input ?? {}) as { outcome?: string; verdict?: string; solutionReveal?: string };
	const outcome = typeof input.outcome === "string" ? input.outcome : "";
	const verdict = typeof input.verdict === "string" ? input.verdict : "";
	const reveal =
		typeof part.reveal === "string" ? part.reveal : typeof input.solutionReveal === "string" ? input.solutionReveal : "";

	// The dismissal synthesis: no verdict, no reveal — one muted line (the
	// learner clicked; the record needs only the fact).
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
			{/* The heading row: the plain 'Concluded' overline + the outcome
			    pill — never two same-weight headings stacked. */}
			<div className="pcard-h">
				<span className="pcard-o">Concluded</span>
				{(OUTCOME_LABEL[outcome] ?? "") !== "" && <span className={OUTCOME_CHIP[outcome] ?? OUTCOME_CHIP.movedOn}>{OUTCOME_LABEL[outcome]}</span>}
			</div>
			{/* The verdict — plain prose under the heading, no 'Verdict:'
			    label: the quiet register of quiz explanations. */}
			{verdict.length > 0 && (
				<div className="pcard-verdict">
					<MessageResponse>{repairMathForDisplay(verdict)}</MessageResponse>
				</div>
			)}
			{/* Then a hairline, then the labeled model solution (Slice G: the
			    hero is the pose's commitment, verbatim). */}
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

/* THE METADATA POPOVER (owner round 17 refinement, 2026-10-06 — full
 * transparency): a quiet METADATA trigger at the very bottom of the
 * conclude card (no divider — it just sits there); click opens the
 * info-box register of the graph-view node cards (rounded-xl border
 * bg-card p-4 shadow-lg, opening BELOW the trigger — always); any scroll or
 * click outside closes it (plus Esc, claimed from the layered chain
 * per the popover law). Shows every field the agent filled in both the
 * problem call (mode, targets — names resolved lazily) and the
 * conclude call (outcome, rung, miss class, retest). Statement and
 * modelSolution stay out — they are the visible card. The data keeps
 * the original SMALL register (text-xs rows, mono values — owner
 * correction: the 15px pass was way too large); the trigger matches
 * the eyebrow size; the box opens BELOW the trigger, always. */
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
	// The portal's anchor (owner fix, 2026-10-06): the box is placed from
	// the trigger's viewport rect AT OPEN TIME — any scroll closes the
	// box, so there is nothing to track.
	const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);
	const [names, setNames] = useState<Record<string, string> | null>(null);
	const targets = Array.isArray(problemInput.target)
		? problemInput.target.filter((t): t is string => typeof t === "string")
		: [];
	// Resolve names only when there is something to resolve.
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
							// Below the trigger, always; clamped so the 320px box
							// never leaves the viewport's right edge.
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
						// PORTALED TO BODY (owner fix, 2026-10-06): the transcript's
						// MessageContent boxes carry overflow-hidden — an absolutely
						// positioned child clips at its own message block's edge (the
						// cut-off bug). A fixed-position portal sits on top of
						// EVERYTHING, the dialogs' law. Node-card info-box register;
						// opening BELOW the trigger — always.
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
	// The unified row (owner rounds, 2026-10-05): one style, one label —
	// 50%-italic quote block on expand. Legacy records' commit flag is
	// deliberately unread (one lane now). A TRANSCRIPT row (owner round,
	// 2026-10-07): full-width band + rail, arriving expanded.
	// Working sent with a hint request carries the rung as a chip.
	return <ThinkingBlock testId="thinking-card" label="Your thinking" tag={isHintRung(data.hint) ? hintTag(data.hint) : undefined} text={data.text} defaultOpen />;
}
