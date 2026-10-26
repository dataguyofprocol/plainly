"use client";

/**
 * THE LESSON PANEL (v4 redesign, owner 2026-10-26): the right-hand column
 * of a lesson on a wide window — the open question beside the text it is
 * about, instead of a dock floating over it. Three tabs:
 *
 *   Question — the pending check (the same QuestionDock form the bottom
 *              dock uses). A teach-phase check still waits behind its
 *              reveal card so the learner reads the step first; the
 *              reading-thinking field lives under that card.
 *   Path     — the plan as a list: where you are, where you have been.
 *              POSITION, never mastery: plan statuses derive from which
 *              node the latest check was ABOUT (derivePlanStatuses), so
 *              the copy says "visited", not "understood".
 *   Helpers  — this lesson's sub-agent jobs (research, demos, figures).
 *
 * Narrow windows keep the bottom dock (chat.tsx DockOverlay) — the panel
 * renders only when chat.tsx measures room for it (LESSON_PANEL_MIN).
 * Because nothing overlays the transcript here, none of the dock's fold /
 * reserve / scroll-mute machinery applies.
 */

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { CheckIcon, CircleAlertIcon, MapIcon } from "lucide-react";
import { BrailleSpinner } from "@/components/braille-spinner";
import { revealArrival } from "@/components/chat";
import { finishDictation } from "@/components/dictation";
import { JobsContext } from "@/components/jobs-context";
import { latestTree, type PopupMessage } from "@/components/plan-block";
import { QuestionDock } from "@/components/question-dock";
import { ReadingThinkingField } from "@/components/reading-thinking";
import { cn } from "@/lib/utils";
import { derivedNodeStatus, derivePlanStatuses, type JobRecord, type PlanNodeStatus, type PlanTree, type QuestionAnswerData } from "@/src/core";

/** The chat area width at which the panel replaces the bottom question
 *  dock: a ~620px reading column + the 380px panel. */
export const LESSON_PANEL_MIN = 1000;

export interface PlanStep {
	id: string;
	title: string;
	status: PlanNodeStatus;
}

export interface PlanProgress {
	steps: PlanStep[];
	visited: number;
	total: number;
	/** 1-based position of the current step in the list; null before any check. */
	currentIndex: number | null;
}

/** Pure: the plan as an ordered list with derived statuses. Exported for
 *  tests and for the header's step ticks. */
export function planProgress(tree: PlanTree | null, messages: readonly PopupMessage[]): PlanProgress | null {
	if (!tree || tree.nodes.length === 0) return null;
	const statuses = derivePlanStatuses(tree, messages as Parameters<typeof derivePlanStatuses>[1]);
	const steps = tree.nodes.map((n) => ({ id: n.id, title: n.title, status: derivedNodeStatus(statuses, n.id) }));
	const current = steps.findIndex((s) => s.status === "current");
	return {
		steps,
		visited: steps.filter((s) => s.status === "visited").length,
		total: steps.length,
		currentIndex: current === -1 ? null : current + 1,
	};
}

type Pending = { tool: string; toolCallId: string; input: unknown };
type Tab = "question" | "path" | "helpers";

const JOB_LABEL: Record<JobRecord["kind"], string> = {
	research: "Researcher",
	demo: "Demo builder",
	visual: "Figure maker",
	pdf: "PDF reader",
};

export function LessonPanel({
	messages,
	pending,
	requiresReveal,
	phase,
	compactionRunning,
	readingThinking,
	onReadingThinking,
	onSubmitAnswer,
	dictationCancel,
	onOpenPlan,
}: {
	messages: readonly PopupMessage[];
	pending: Pending | null;
	requiresReveal: boolean;
	phase: "probe" | "plan" | "teach";
	compactionRunning: boolean;
	readingThinking: string;
	onReadingThinking: (v: string) => void;
	onSubmitAnswer: (output: QuestionAnswerData) => void;
	dictationCancel?: () => void;
	onOpenPlan: () => void;
}) {
	const jobs = useContext(JobsContext);
	const progress = useMemo(() => planProgress(latestTree(messages), messages), [messages]);
	const [tab, setTab] = useState<Tab>("question");

	// Reveal state per question (the dock's W5 rule, unchanged): a teach
	// check arrives behind its card unless it follows another question.
	const pendingId = pending?.toolCallId ?? null;
	const [revealed, setRevealed] = useState(!requiresReveal);
	const prevPendingRef = useRef(pendingId);
	if (pendingId !== prevPendingRef.current) {
		const wasQuestion = prevPendingRef.current !== null;
		prevPendingRef.current = pendingId;
		if (pendingId) {
			setRevealed(requiresReveal ? revealArrival(wasQuestion).revealed : true);
			setTab("question");
		}
	}
	const revealPending = !!pending && requiresReveal && !revealed;

	// ENTER OPENS THE WAITING CHECK (the dock's keyboard rule): with the
	// check behind its card and plain focus, Enter finishes any dictation
	// first (the flush lands in the reading-thinking field), then reveals.
	useEffect(() => {
		if (!revealPending) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Enter" || e.altKey || (e.shiftKey && !e.metaKey && !e.ctrlKey)) return;
			const t = e.target as HTMLElement | null;
			if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.isContentEditable || t.closest("button"))) return;
			e.preventDefault();
			void finishDictation().then(() => setRevealed(true));
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [revealPending]);

	const running = jobs.filter((j) => j.status === "running").length;
	const tabs: { id: Tab; label: string; badge?: string; dot?: boolean }[] = [
		{ id: "question", label: "Question", dot: !!pending },
		{ id: "path", label: "Path", badge: progress ? `${progress.currentIndex ?? progress.visited}/${progress.total}` : undefined },
		{ id: "helpers", label: "Helpers", badge: running ? String(running) : undefined },
	];

	return (
		<aside
			aria-label="Question and lesson details"
			data-testid="lesson-panel"
			className="flex w-95 shrink-0 flex-col overflow-hidden border-l border-border bg-card"
			// The panel is a narrower measure than the reading column: prose
			// steps down to 15px here, and the question's own scroller leaves
			// room for its confidence, thinking and submit rows below it.
			style={{ "--dock-max-h": "calc(100dvh - 19rem)", "--lh-prose-size": "15px" } as React.CSSProperties}
		>
			<div role="tablist" className="lh-drag flex h-15 shrink-0 items-center gap-1 border-b border-border px-3">
				{tabs.map((t) => (
					<button
						key={t.id}
						type="button"
						role="tab"
						aria-selected={tab === t.id}
						data-testid={`lesson-tab-${t.id}`}
						onClick={() => setTab(t.id)}
						className={cn(
							"flex h-8 flex-1 items-center justify-center gap-1.5 rounded-md text-sm font-medium transition-colors",
							tab === t.id ? "bg-popover font-semibold text-foreground shadow-[0_1px_2px_var(--shadow)]" : "text-muted-foreground hover:text-foreground",
						)}
					>
						{t.label}
						{t.dot && <span aria-label="waiting on you" className="size-1.5 rounded-full bg-warn" />}
						{t.badge && <span className="font-mono text-xs text-faint">{t.badge}</span>}
					</button>
				))}
			</div>

			<div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto">
				{tab === "question" &&
					(pending ? (
						<div className="flex flex-col gap-3 p-3">
							<div className="overflow-hidden rounded-xl border border-border bg-popover">
								<QuestionDock
									toolName={pending.tool as "quiz" | "probe" | "ask_user_question" | "explain" | "recall"}
									toolCallId={pending.toolCallId}
									input={pending.input as never}
									expanded={!revealPending}
									reveal={revealPending}
									phase={phase}
									onExpand={() => void finishDictation().then(() => setRevealed(true))}
									onSubmit={onSubmitAnswer}
									onEscape={dictationCancel}
									dictationClaim={!revealPending}
									compactionRunning={compactionRunning}
								/>
							</div>
							{/* Thinking while reading (owner 2026-10-03): mounted while a
							    teach check waits; it rides the check answer on submit. */}
							{requiresReveal && (
								<ReadingThinkingField
									value={readingThinking}
									onChange={onReadingThinking}
									onEscape={dictationCancel}
									onOpen={revealPending ? () => void finishDictation().then(() => setRevealed(true)) : undefined}
									claim={revealPending}
								/>
							)}
						</div>
					) : (
						<p className="p-5 text-sm text-muted-foreground">
							No question right now. Checks appear here as the lesson goes; ask or steer any time below.
						</p>
					))}

				{tab === "path" &&
					(progress ? (
						<div className="flex flex-col gap-3 p-4">
							<div className="flex items-center justify-between gap-3">
								<span className="text-sm text-muted-foreground">
									{progress.visited} of {progress.total} visited
									{progress.currentIndex !== null && ` · on step ${progress.currentIndex}`}
								</span>
								<button
									type="button"
									onClick={onOpenPlan}
									className="flex h-7 items-center gap-1.5 rounded-md border border-border bg-popover px-2.5 text-xs font-semibold transition-colors hover:bg-accent"
								>
									<MapIcon className="size-3.5" aria-hidden />
									Open map
								</button>
							</div>
							<div className="h-1.5 overflow-hidden rounded-full bg-muted" aria-hidden>
								<div className="h-full rounded-full bg-brand transition-[width] duration-700" style={{ width: `${(progress.visited / progress.total) * 100}%` }} />
							</div>
							<ol className="flex flex-col gap-px" data-testid="path-steps">
								{progress.steps.map((s) => (
									<li
										key={s.id}
										data-status={s.status}
										className={cn(
											"flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm",
											s.status === "current" ? "bg-brand-soft font-semibold text-foreground" : "text-muted-foreground",
										)}
									>
										<span
											aria-hidden
											className={cn(
												"size-2 shrink-0 rounded-full border-[1.5px]",
												s.status === "current" ? "border-brand bg-brand" : s.status === "visited" ? "border-faint bg-faint" : "border-faint",
											)}
										/>
										<span className="min-w-0 flex-1">{s.title}</span>
									</li>
								))}
							</ol>
						</div>
					) : (
						<p className="p-5 text-sm text-muted-foreground">The path appears once the check-in finds where you are.</p>
					))}

				{tab === "helpers" &&
					(jobs.length > 0 ? (
						<ul className="flex flex-col gap-2 p-3" data-testid="helper-jobs">
							{[...jobs].reverse().map((j) => (
								<li key={j.id} className="flex flex-col gap-1 rounded-lg bg-muted px-3 py-2.5">
									<span className="flex items-center gap-2 text-sm font-semibold">
										{JOB_LABEL[j.kind]}
										<span className="ml-auto flex items-center gap-1 text-xs font-medium text-muted-foreground">
											{j.status === "running" ? (
												<BrailleSpinner label="Running" />
											) : j.status === "done" ? (
												<CheckIcon className="size-3.5 text-good" aria-label="Done" />
											) : (
												<CircleAlertIcon className="size-3.5 text-danger" aria-label="Failed" />
											)}
										</span>
									</span>
									{j.activity && <span className="line-clamp-2 text-xs text-muted-foreground">{j.activity}</span>}
								</li>
							))}
						</ul>
					) : (
						<p className="p-5 text-sm text-muted-foreground">
							Helpers research, build demos and draw figures when the lesson calls for one. Nothing has run in this lesson yet.
						</p>
					))}
			</div>
		</aside>
	);
}
