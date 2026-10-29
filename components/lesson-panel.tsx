"use client";

/**
 * THE DOCKS (v4 rebuild, 2026-10-26) — the right-hand column of a session,
 * as Lesson4 and Practice4 draw it. Always present: on narrow windows the
 * artboards' own breakpoint stacks it under the reading column.
 *
 *   LessonPanel   Prediction / Check / Question — the open question (the
 *                 QuestionDock form); a teach-phase check still waits behind
 *                 its reveal card so the learner reads the step first, with
 *                 the thinking-while-reading field under it.
 *                 Path — the plan as POSITION (visited / current / upcoming,
 *                 never mastery: statuses derive from which node the latest
 *                 check was ABOUT), with the map.
 *                 Helpers — this lesson's sub-agents and its numbers: time,
 *                 answers, context, tokens, cost.
 *   PracticePanel Your working — the field, how sure, the hint ladder
 *                 (Nudge → Bigger hint → First step), submit; then the set.
 */

import { useContext, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { MessageResponse } from "@/components/ai-elements/message";
import { DictationErrorLine, DictationMic, finishDictation, useDictationState, useDictationTarget, joinDictation } from "@/components/dictation";
import { JobsContext } from "@/components/jobs-context";
import { CONFIDENCE_LEVEL_COLORS, nearestLevel } from "@/components/confidence-colors";
import { ConfidenceLadder } from "@/components/confidence-rail";
import { catalogLimits, useModelCatalog } from "@/components/model-picker";
import { latestTree, type PopupMessage } from "@/components/plan-block";
import { QuestionDock } from "@/components/question-dock";
import { ReadingThinkingField } from "@/components/reading-thinking";
import { formatTokens, planCostLabel } from "@/components/usage-format";
import { useChats } from "@/components/v4/data";
import { EmptyState } from "@/components/ui/empty-state";
import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
	CONFIDENCE_LEVELS,
	HINT_RUNGS,
	PRACTICE_SET_SIZE,
	derivedNodeStatus,
	derivePlanStatuses,
	type HintRung,
	type JobRecord,
	type PlanNodeStatus,
	type PlanTree,
	type QuestionAnswerData,
	subscriptionLabels,
	type SessionPricing,
	type TurnUsage,
} from "@/src/core";

/**
 * How a teach-phase question arrives (owner ruling, 2026-09-25): behind its
 * reveal card when it follows the composer — the learner reads the
 * teaching first — but OPEN when it follows another question (a queued
 * parallel check): the reading already happened. Pure for tests.
 */
export function revealArrival(wasQuestion: boolean): { expanded: boolean; revealed: boolean } {
	return wasQuestion ? { expanded: true, revealed: true } : { expanded: false, revealed: false };
}

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

const JOB_ICON: Record<JobRecord["kind"], IconName> = {
	research: "research",
	demo: "demo",
	visual: "figure",
	pdf: "pdf",
};

/** The question tab's name — what kind of question waits (Lesson4 calls a
 *  predict-type check "Prediction"). */
function questionTabLabel(pending: Pending | null): string {
	if (!pending) return "Question";
	const type = (pending.input as { type?: unknown } | undefined)?.type;
	if (type === "predict") return "Prediction";
	if (pending.tool === "quiz" || pending.tool === "probe" || pending.tool === "explain" || pending.tool === "recall") return "Check";
	return "Question";
}

/** The last answered question in the transcript (the dock shows it while
 *  the tutor replies). */
function lastAnswer(messages: readonly PopupMessage[]): QuestionAnswerData | null {
	for (let i = messages.length - 1; i >= 0; i--) {
		const parts = messages[i]!.parts;
		for (let j = parts.length - 1; j >= 0; j--) {
			const p = parts[j]!;
			if (!/^tool-(quiz|probe|explain|recall|ask_user_question)$/.test(p.type) || p.state !== "output-available") continue;
			const out = p.output as QuestionAnswerData | undefined;
			if (out && !out.dismissed) return out;
		}
	}
	return null;
}

/** Pure: the lesson's cost, honestly (the money-channel doctrine the stats
 *  bar carried): dollars only when at least one turn priced, subscription
 *  use named by its provider, never a fake $0. Exported for tests. */
export function lessonCostLabel(turns: readonly TurnUsage[], pricing: SessionPricing | undefined): string {
	const { cost = 0, unpriced = turns.length, subscription = 0 } = pricing ?? {};
	const priced = turns.length - unpriced - subscription;
	const providers = pricing?.subscriptionProviders ?? subscriptionLabels(turns.map((t) => t.model));
	return planCostLabel(priced > 0 ? cost : null, providers);
}

function sumTokens(turns: readonly TurnUsage[]): number {
	let n = 0;
	for (const t of turns) for (const s of t.steps) n += (s.inputTokens ?? 0) + (s.outputTokens ?? 0) + (s.cacheReadTokens ?? 0) + (s.cacheWriteTokens ?? 0);
	return n;
}

export function LessonPanel({
	messages,
	pending,
	requiresReveal,
	phase,
	compactionRunning,
	readingThinking,
	onReadingThinking,
	onSubmitAnswer,
	dictationStop,
	onOpenPlan,
	busy,
	turns,
	contextTokens,
	pricing,
	chatId,
}: {
	messages: readonly PopupMessage[];
	pending: Pending | null;
	requiresReveal: boolean;
	phase: "probe" | "plan" | "teach";
	compactionRunning: boolean;
	readingThinking: string;
	onReadingThinking: (v: string) => void;
	onSubmitAnswer: (output: QuestionAnswerData) => void;
	dictationStop?: () => void;
	onOpenPlan: () => void;
	busy: boolean;
	turns: TurnUsage[];
	contextTokens: number | null;
	pricing?: SessionPricing;
	chatId: string;
}) {
	const jobs = useContext(JobsContext);
	const progress = useMemo(() => planProgress(latestTree(messages), messages), [messages]);
	const [tab, setTab] = useState<Tab>("question");
	// The learner chose a tab since the dock last moved on its own — the
	// resting rule below never overrides a deliberate pick.
	const [picked, setPicked] = useState(false);

	// Reveal state per question (the W5 rule, unchanged).
	const pendingId = pending?.toolCallId ?? null;
	const [revealed, setRevealed] = useState(!requiresReveal);
	const prevPendingRef = useRef(pendingId);
	if (pendingId !== prevPendingRef.current) {
		const wasQuestion = prevPendingRef.current !== null;
		prevPendingRef.current = pendingId;
		if (pendingId) {
			setRevealed(requiresReveal ? revealArrival(wasQuestion).revealed : true);
			setTab("question");
			setPicked(false);
		}
	}
	const revealPending = !!pending && requiresReveal && !revealed;

	// THE RESTING TAB (PM, finesse pass 2026-10-26): with no question
	// pending and the tutor not mid-reply, the dock rests on Path — an empty
	// question tab is not a place to open on. Without a plan the question
	// tab keeps the spot (its resting state says what comes next). While
	// the tutor replies to an answer, the question tab stays put so the
	// learner sees their answer land.
	const restTab: Tab | null = !pending && !busy ? (progress ? "path" : "question") : null;
	const [prevRestTab, setPrevRestTab] = useState<Tab | null>(null);
	if (restTab !== prevRestTab) {
		setPrevRestTab(restTab);
		if (restTab && !picked) setTab(restTab);
	}

	// A question just landed: ring the dock (a few seconds — the CSS runs
	// three pulses), and if the window isn't in front, a system
	// notification says it's the learner's turn.
	const [attn, setAttn] = useState(false);
	useEffect(() => {
		if (!pendingId) return;
		setAttn(true);
		const t = window.setTimeout(() => setAttn(false), 3800);
		notifyYourTurn(pending);
		return () => window.clearTimeout(t);
		// fire once per question
	}, [pendingId]);

	// The transcript's "your turn" card asks the dock to take focus: open
	// the question tab, reveal a waiting check (the click is the learner's
	// "I've read it"), and put the walk on the first row.
	useEffect(() => {
		const on = () => {
			setTab("question");
			void finishDictation().then(() => {
				setRevealed(true);
				window.setTimeout(() => document.querySelector<HTMLElement>('[data-testid="lesson-panel"] [data-kbdrow="0"]')?.focus(), 60);
			});
		};
		window.addEventListener("lh:focus-question", on);
		return () => window.removeEventListener("lh:focus-question", on);
	}, []);

	// ENTER OPENS THE WAITING CHECK: with the check behind its card and
	// plain focus, Enter finishes any dictation first (the flush lands in
	// the reading-thinking field), then reveals.
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
	const answered = !pending ? lastAnswer(messages) : null;
	const tabs: { id: Tab; icon: IconName; label: string; count?: string; wait?: boolean }[] = [
		{ id: "question", icon: "ask", label: pending ? "Your turn" : questionTabLabel(pending), wait: !!pending },
		{ id: "path", icon: "path", label: "Path", count: progress ? `${progress.currentIndex ?? progress.visited}/${progress.total}` : undefined },
		{ id: "helpers", icon: "agent", label: "Helpers", count: running ? String(running) : undefined },
	];

	return (
		<aside className="dock" aria-label="Question and lesson details" data-testid="lesson-panel">
			<div className={cn("dockin glass", attn && "attn")}>
				<div className="tabs" role="tablist" aria-label="Lesson dock">
					{tabs.map((t) => (
						<button
							key={t.id}
							type="button"
							role="tab"
							aria-selected={tab === t.id}
							className={cn(tab === t.id && "on", t.wait && "wait")}
							onClick={() => {
								setTab(t.id);
								setPicked(true);
							}}
							data-testid={`lesson-tab-${t.id}`}
						>
							<Icon name={t.icon} size="sm" />
							<span className="tab-l">{t.label}</span>
							{t.wait && <span className="ping" aria-label="waiting on you" />}
							{t.count && <span className="tab-n">{t.count}</span>}
						</button>
					))}
				</div>

				{tab === "question" && (
					<div className="pane fade" role="tabpanel">
						{pending ? (
							<>
								<QuestionDock
									toolName={pending.tool as "quiz" | "probe" | "ask_user_question" | "explain" | "recall"}
									toolCallId={pending.toolCallId}
									input={pending.input as never}
									expanded={!revealPending}
									reveal={revealPending}
									phase={phase}
									onExpand={() => void finishDictation().then(() => setRevealed(true))}
									onSubmit={onSubmitAnswer}
									onEscape={dictationStop}
									dictationClaim={!revealPending}
									compactionRunning={compactionRunning}
								/>
								{requiresReveal && revealPending && (
									<ReadingThinkingField
										value={readingThinking}
										onChange={onReadingThinking}
										onEscape={dictationStop}
										onOpen={() => void finishDictation().then(() => setRevealed(true))}
										claim={revealPending}
									/>
								)}
							</>
						) : (
							<QuestionRest answered={answered} busy={busy} phase={phase} />
						)}
					</div>
				)}

				{tab === "path" && (
					<div className="pane fade" role="tabpanel">
						{progress ? <PathSteps progress={progress} onOpenPlan={onOpenPlan} /> : (
							<EmptyState icon="path" title="Your path is on its way">
								The check-in finds where you are first, then lays out the steps.
							</EmptyState>
						)}
					</div>
				)}

				{tab === "helpers" && (
					<div className="pane fade" role="tabpanel">
						{jobs.length === 0 ? (
							<EmptyState icon="agent" title="No helpers yet">
								When the lesson calls for one, helpers research, build demos and draw figures.
							</EmptyState>
						) : (
							<ul className="agents">
								{[...jobs].reverse().map((j) => (
									<li key={j.id} className={cn("agent", j.status)}>
										<span className="agent-ic" aria-hidden="true">
											<Icon name={JOB_ICON[j.kind]} size="sm" />
										</span>
										<span className="agent-tx">
											<span className="agent-n">{JOB_LABEL[j.kind]}</span>
											{(j.status === "running" || (j.activity && !/^(done|failed)$/i.test(j.activity))) && (
												<span className="agent-a">
													{j.status === "running" ? [j.activity, elapsed(j.createdAt)].filter(Boolean).join(" · ") : j.activity}
												</span>
											)}
										</span>
										<span className={cn("pill", j.status === "running" ? "brand" : j.status === "done" ? "good" : "danger")}>
											{j.status === "running" ? "Working" : j.status === "done" ? "Done" : "Failed"}
										</span>
										{j.status === "running" && (
											<span className="ind" aria-hidden="true">
												<i />
											</span>
										)}
									</li>
								))}
							</ul>
						)}
						<LessonNumbers chatId={chatId} turns={turns} contextTokens={contextTokens} pricing={pricing} />
					</div>
				)}
			</div>
		</aside>
	);
}

/** The question tab at rest: the last answer, compact, and what comes
 *  next — the tutor replying, or where the next check will land. */
function QuestionRest({ answered, busy, phase }: { answered: QuestionAnswerData | null; busy: boolean; phase: "probe" | "plan" | "teach" }) {
	const conf = answered?.confidence !== undefined ? nearestLevel(answered.confidence) : null;
	const confColor = conf ? CONFIDENCE_LEVEL_COLORS[conf.value] : undefined;
	const said = answered
		? answered.dontKnow
			? "I don’t know yet"
			: answered.options?.filter((o) => answered.answers.some((a) => a.index === o.index)).map((o) => o.label).join("; ") || answered.text || answered.other || ""
		: "";
	return (
		<div className="qrest">
			{answered && (
				<div className="qlast settle">
					<div className="qlast-h">
						<span className="over">{answered.questionType === "predict" ? "You predicted" : "You answered"}</span>
						{answered.correct === true && <span className="pill good">Right</span>}
						{answered.correct === false && <span className="pill muted">Not quite</span>}
						{conf && confColor && (
							<span className="pill lvl" style={{ "--lvl": confColor.ink, "--lvl-soft": confColor.soft } as CSSProperties}>
								{conf.label}
							</span>
						)}
					</div>
					{said && <p className="qlast-a">{said}</p>}
				</div>
			)}
			{busy ? (
				<div className="qreply settle" role="status">
					<span className="qreply-t">
						<span className="wave" aria-hidden="true">
							<i />
							<i />
							<i />
							<i />
						</span>
						The tutor is replying in the lesson
					</span>
					<span className="ind" aria-hidden="true">
						<i />
					</span>
				</div>
			) : answered ? (
				<EmptyState icon="ask" title="Your next check will appear here">
					Keep reading. You can ask or steer any time from the box below.
				</EmptyState>
			) : (
				<EmptyState icon="ask" title={phase === "probe" ? "The check-in’s questions land here" : "No question right now"}>
					{phase === "probe" ? "A few quick ones, to find where you are." : "Checks show up here as the lesson goes. Ask or steer any time below."}
				</EmptyState>
			)}
		</div>
	);
}

/** Path: where you are in the plan — a vertical stepper (visited / current
 *  / upcoming are POSITION, never mastery), with the map one click away. */
function PathSteps({ progress, onOpenPlan }: { progress: PlanProgress; onOpenPlan: () => void }) {
	const currentRef = useRef<HTMLLIElement>(null);
	// Long plans: open with the current step in view.
	useEffect(() => {
		currentRef.current?.scrollIntoView({ block: "nearest" });
	}, []);
	const at = progress.currentIndex ?? progress.visited;
	return (
		<>
			<div className="path-h">
				<div className="path-hx">
					<span className="h">{progress.currentIndex !== null ? `Step ${progress.currentIndex} of ${progress.total}` : `${progress.total} steps`}</span>
					<span className="t-meta faint">{progress.visited === 0 ? "None visited yet" : `${progress.visited} visited`}</span>
				</div>
				<button type="button" className="btn sm secondary" onClick={onOpenPlan}>
					<Icon name="plan" size="sm" />
					Open map
				</button>
			</div>
			<div className="pbar" aria-hidden="true">
				<i style={{ transform: `scaleX(${(at / progress.total).toFixed(3)})` }} />
			</div>
			<ol className="stepper" data-testid="path-steps">
				{progress.steps.map((st) => (
					<li
						key={st.id}
						ref={st.status === "current" ? currentRef : undefined}
						className={cn("step", st.status === "current" ? "c" : st.status === "visited" ? "d" : "")}
						data-status={st.status}
						aria-current={st.status === "current" ? "step" : undefined}
					>
						<i aria-hidden="true" />
						<span className="step-t">{st.title}</span>
					</li>
				))}
			</ol>
		</>
	);
}

/** The "your turn" system notification — only when the window isn't in
 *  front (in-app, the dock's ring says it). Permission is asked once,
 *  the first time it would be useful; Electron grants it for the app. */
function notifyYourTurn(pending: Pending | null): void {
	if (!pending || typeof window === "undefined" || !("Notification" in window)) return;
	if (document.visibilityState === "visible" && document.hasFocus()) return;
	const q = (pending.input as { question?: unknown } | undefined)?.question;
	const body = typeof q === "string" ? q.replace(/\s+/g, " ").slice(0, 140) : "The tutor asked you something.";
	const show = () => {
		try {
			const n = new Notification("Your turn", { body, silent: false });
			n.onclick = () => {
				window.focus();
				n.close();
			};
		} catch {
			// notifications unavailable — the in-app ring still shows
		}
	};
	if (Notification.permission === "granted") show();
	else if (Notification.permission === "default") void Notification.requestPermission().then((p) => p === "granted" && show());
}

function elapsed(iso: string): string {
	const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
	return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min`;
}

/** Helpers' "This lesson" block (Lesson4): time, answers, context, tokens,
 *  cost — a stat list, the context meter against the model's window. */
function LessonNumbers({ chatId, turns, contextTokens, pricing }: { chatId: string; turns: TurnUsage[]; contextTokens: number | null; pricing?: SessionPricing }) {
	const chats = useChats();
	const me = chats?.find((c) => c.id === chatId);
	const { catalog } = useModelCatalog();
	const model = turns.at(-1)?.model;
	const limit = model && catalog ? (catalogLimits(catalog).get(model) ?? null) : null;
	const tokens = sumTokens(turns);
	const rows: Array<[string, string]> = [
		["Time", me?.minutes === undefined ? "—" : me.minutes < 1 ? "< 1 min" : `${me.minutes} min`],
		["Answers", me?.answers ? `${me.answers.total} · ${me.answers.firstTry} first try` : "—"],
		["Context", `${contextTokens === null ? "—" : formatTokens(contextTokens)}${limit ? ` / ${formatTokens(limit)}` : ""}`],
		["Tokens", tokens > 0 ? formatTokens(tokens) : "—"],
		["Cost", lessonCostLabel(turns, pricing)],
	];
	const fill = limit && contextTokens !== null ? Math.min(1, contextTokens / limit) : null;
	return (
		<section className="stats">
			<span className="over">This lesson</span>
			<dl className="stat">
				{rows.map(([k, v]) => (
					<div key={k}>
						<dt>{k}</dt>
						<dd>
							{k === "Context" && fill !== null && (
								<span className="meter" aria-hidden="true">
									<i style={{ transform: `scaleX(${fill.toFixed(3)})` }} />
								</span>
							)}
							<span className="mono num">{v}</span>
						</dd>
					</div>
				))}
			</dl>
		</section>
	);
}

// ─── Practice ───────────────────────────────────────────────────────────────

export interface SetProblem {
	id: string;
	/** The conclude's outcome once the problem is closed; null while open. */
	outcome: string | null;
}

/** Pure: the practice set so far, from the transcript — each settled
 *  `problem` call opens an entry, each acknowledged `conclude` closes the
 *  latest open one with its outcome. A problem's ack carries no payload,
 *  so the view keeps a settled pose at input-available (view.ts, the
 *  placeholder fork); errored and still-streaming calls count for nothing.
 *  Exported for tests and the header. */
export function practiceSet(messages: readonly PopupMessage[]): SetProblem[] {
	const set: SetProblem[] = [];
	for (const m of messages) {
		for (const part of m.parts) {
			if (part.type === "tool-problem") {
				if (part.state !== "input-available" && part.state !== "output-available") continue;
				set.push({ id: (part as { toolCallId?: string }).toolCallId ?? `p${set.length}`, outcome: null });
			} else if (part.type === "tool-conclude" && part.state === "output-available") {
				const open = [...set].reverse().find((p) => p.outcome === null);
				const outcome = (part.input as { outcome?: unknown } | undefined)?.outcome;
				if (open) open.outcome = typeof outcome === "string" ? outcome : "movedOn";
			}
		}
	}
	return set;
}


/** A set row's status: its label and pill tone (Practice marks wear the
 *  warm --practice; the problem being worked is the brand's "current"). */
function setStatus(p: SetProblem | undefined): { label: string; tone: string } | null {
	if (!p) return null;
	if (p.outcome === null) return { label: "Working", tone: "brand" };
	if (p.outcome === "solved") return { label: "Solid", tone: "good" };
	if (p.outcome === "solvedWithHints") return { label: "With hints", tone: "practice" };
	if (p.outcome === "dismissed") return { label: "Skipped", tone: "muted" };
	return { label: "Moved on", tone: "muted" };
}

/** Hints the learner asked for on one problem, read off the view's
 *  practice-thinking parts (each carries its rung when it was a hint). */
function hintsOn(messages: readonly PopupMessage[], problemId: string): number {
	let n = 0;
	for (const m of messages)
		for (const part of m.parts) {
			if (part.type !== "data-practice-thinking") continue;
			const d = (part as { data?: { problemCallId?: unknown; hint?: unknown } }).data;
			if (d?.problemCallId === problemId && (d.hint === 1 || d.hint === 2 || d.hint === 3)) n += 1;
		}
	return n;
}

export interface OpenedHint {
	rung: HintRung;
	label: string;
	/** The tutor's reply to the request (its plain text), or null while it
	 *  hasn't arrived yet. */
	text: string | null;
}

/** Pure: the hints opened on one problem, each paired with the tutor's
 *  reply. A hint request is a practice-thinking marker carrying a rung; the
 *  hint itself is the text of the assistant message(s) that follow it, up
 *  to the learner's next message. Thinking and tool parts are skipped.
 *  Exported for tests. */
export function practiceHints(messages: readonly PopupMessage[], problemId: string): OpenedHint[] {
	const out: OpenedHint[] = [];
	let open: OpenedHint | null = null;
	for (const m of messages) {
		const role = (m as { role?: string }).role;
		if (role === "assistant") {
			if (!open) continue;
			const text = m.parts
				.filter((p) => p.type === "text")
				.map((p) => (p as { text?: string }).text ?? "")
				.join("\n\n")
				.trim();
			if (text) open.text = open.text ? `${open.text}\n\n${text}` : text;
			continue;
		}
		open = null;
		for (const part of m.parts) {
			if (part.type !== "data-practice-thinking") continue;
			const d = (part as { data?: { problemCallId?: unknown; hint?: unknown } }).data;
			if (d?.problemCallId !== problemId || (d.hint !== 1 && d.hint !== 2 && d.hint !== 3)) continue;
			const rung = d.hint as HintRung;
			open = { rung, label: HINT_RUNGS[rung - 1]!.label, text: null };
			out.push(open);
		}
	}
	return out;
}

/** Pure: the indices of assistant messages that answer a hint request (any
 *  problem) — the same walk as practiceHints(). Hints live in the panel,
 *  so the transcript folds these replies' text and thinking. Exported for
 *  tests. */
export function hintReplyIndices(messages: readonly PopupMessage[]): Set<number> {
	const out = new Set<number>();
	let open = false;
	messages.forEach((m, i) => {
		if ((m as { role?: string }).role === "assistant") {
			if (open) out.add(i);
			return;
		}
		open = m.parts.some((part) => {
			if (part.type !== "data-practice-thinking") return false;
			const hint = (part as { data?: { hint?: unknown } }).data?.hint;
			return hint === 1 || hint === 2 || hint === 3;
		});
	});
	return out;
}

const HINT_ASK: Record<HintRung, string> = { 1: "Show a nudge", 2: "Show a bigger hint", 3: "Show the first step" };

/** One opened hint: a quiet card. The newest is open; an older one folds
 *  to its first line until "Show" (owner, 2026-10-27). Exported for tests. */
export function HintCard({ hint, latest }: { hint: OpenedHint; latest: boolean }) {
	const [expanded, setExpanded] = useState(false);
	const open = latest || expanded;
	return (
		<div className={cn("hcard", open && "open")} data-testid="practice-hint-card">
			<span className="hcard-h">
				<span className="hcard-l">{hint.label}</span>
				{!latest && (
					<button type="button" className="hcard-more" aria-expanded={open} onClick={() => setExpanded((v) => !v)}>
						{open ? "Hide" : "Show"}
					</button>
				)}
			</span>
			{hint.text === null ? (
				<span className="hcard-wait" aria-label="The hint is on its way">
					<i className="skel" />
					<i className="skel" />
				</span>
			) : (
				<div className="hcard-t">
					<MessageResponse>{hint.text}</MessageResponse>
				</div>
			)}
		</div>
	);
}

/** Pure: the set footer's square for one problem slot. */
function slotOf(p: SetProblem | undefined): { cls: string; title: string } {
	if (!p) return { cls: "next", title: "Not started" };
	if (p.outcome === null) return { cls: "now", title: "Working on it" };
	if (p.outcome === "solved") return { cls: "ok", title: "Solved" };
	if (p.outcome === "solvedWithHints") return { cls: "hint", title: "Solved with hints" };
	return { cls: "miss", title: p.outcome === "dismissed" ? "Skipped" : "Moved on" };
}

/**
 * THE PRACTICE DOCK (Practice4): your working for the open problem — the
 * field (with dictation), how sure, the hint ladder, submit — and then the
 * set. A hint request rides the thinking lane with its rung (the server
 * makes the request explicit to the agent; the doctrine's ladder decides
 * what the hint says). Between problems the working gives way to a
 * compact outcome card, with the set right under it.
 */
export function PracticePanel({
	messages,
	practice,
	onSubmitThinking,
	compactionRunning,
	dictationStop,
	turns,
	hintsUsed,
}: {
	messages: readonly PopupMessage[];
	practice: { toolCallId: string; input: unknown } | null;
	onSubmitThinking: (text: string, hint?: HintRung) => void;
	compactionRunning: boolean;
	dictationStop?: () => void;
	turns: TurnUsage[];
	hintsUsed: number;
}) {
	const set = useMemo(() => practiceSet(messages), [messages]);
	const [draft, setDraft] = useState("");
	const draftRef = useRef("");
	const [conf, setConf] = useState<number | null>(null);
	const setText = (v: string) => {
		draftRef.current = v;
		setDraft(v);
	};
	const isTarget = useDictationTarget((t: string) => setText(joinDictation(draftRef.current, t)), !!practice);
	const dictationPhase = useDictationState().phase;
	const dictating = isTarget && dictationPhase !== "idle";
	// A new problem starts clean.
	const problemId = practice?.toolCallId ?? null;
	useEffect(() => {
		setText("");
		setConf(null);
	}, [problemId]);

	const withConfidence = (text: string) => {
		const c = conf === null ? null : CONFIDENCE_LEVELS.find((l) => l.value === conf);
		return c ? `${text}\n\n(How sure: ${c.label.toLowerCase()})` : text;
	};
	const submit = () => {
		const t = draftRef.current.trim();
		if (!t || compactionRunning) return;
		setText("");
		onSubmitThinking(withConfidence(t));
	};
	const nextRung = (Math.min(hintsUsed + 1, HINT_RUNGS.length) as HintRung);
	const askHint = () => {
		if (compactionRunning || hintsUsed >= HINT_RUNGS.length) return;
		const t = draftRef.current.trim();
		setText("");
		onSubmitThinking(t, nextRung);
	};
	const tokens = sumTokens(turns);
	const outOfHints = hintsUsed >= HINT_RUNGS.length;
	const hints = useMemo(() => (problemId ? practiceHints(messages, problemId) : []), [messages, problemId]);
	const last = set.at(-1);
	const lastStatus = setStatus(last);
	// The set's window: the latest five (a second set starts a fresh list).
	const base = Math.floor(Math.max(0, set.length - 1) / PRACTICE_SET_SIZE) * PRACTICE_SET_SIZE;

	return (
		<aside className="dock pdock full" aria-label="Your working" data-testid="practice-panel">
			<div className="dockin glass">
				<div className="pane">
					{practice ? (
						<section className="pwork">
							<div className="qfield">
								<label htmlFor="work" className="h">
									Your working
								</label>
								<div className="fwrap">
									<textarea
										id="work"
										rows={7}
										className={cn("ftext pwork-in", dictating && "dictating")}
										value={draft}
										data-testid="practice-thinking-field"
										onChange={(e) => setText(e.target.value)}
										onKeyDown={(e) => {
											if (e.key === "Escape" && dictationStop) {
												e.stopPropagation();
												dictationStop();
											} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
												e.preventDefault();
												submit();
											}
										}}
										placeholder="Think out loud. Hints read your working; Submit ends the problem."
									/>
									<DictationMic own={isTarget} />
								</div>
								<DictationErrorLine show={isTarget} />
							</div>
							<div className="qfield">
								<span className="qfield-h">
									<span id="sure" className="flabel">
										How sure are you?
									</span>
									<span className="t-meta faint">optional</span>
								</span>
								<ConfidenceLadder value={conf} onChange={setConf} labelledBy="sure" />
							</div>
							<div className="hints">
								{hints.map((h, i) => (
									<HintCard key={h.rung} hint={h} latest={i === hints.length - 1} />
								))}
								<div className="hints-row">
									{outOfHints ? (
										<span className="hints-all">All {HINT_RUNGS.length} hints used</span>
									) : (
										<>
											<button type="button" className="hintlink" disabled={compactionRunning} onClick={askHint} data-testid="practice-hint">
												<Icon name="idea" size="sm" />
												{HINT_ASK[nextRung]}
											</button>
											<span className="t-meta faint">{hintsUsed === 0 ? "3 hints, each says a bit more" : `${hintsUsed} of ${HINT_RUNGS.length} hints used`}</span>
										</>
									)}
								</div>
							</div>
							<button type="button" className="btn brand lg psubmit" disabled={!draft.trim() || compactionRunning} onClick={submit} data-testid="practice-send">
								Submit answer
							</button>
						</section>
					) : last && lastStatus ? (
						<section className="pdone settle" data-testid="practice-done">
							<div className="pdone-h">
								<span className={cn("pdone-ic", lastStatus.tone)} aria-hidden="true">
									<Icon name={last.outcome === "solved" || last.outcome === "solvedWithHints" ? "check" : last.outcome === null ? "loading" : "minus"} size="sm" />
								</span>
								<span className="pdone-t">{last.outcome === null ? `Wrapping up problem ${set.length}` : `Problem ${set.length} done`}</span>
								<span className={cn("pill", lastStatus.tone)}>{lastStatus.label}</span>
							</div>
							<span className="pdone-m">
								{(() => {
									const n = hintsOn(messages, last.id);
									return n === 0 ? "No hints used" : `${n} ${n === 1 ? "hint" : "hints"} used`;
								})()}
							</span>
							<p className="pdone-next">
								Press <span className="kbd">↵</span> in the box below for the next problem, or ask about this one.
							</p>
						</section>
					) : (
						<EmptyState icon="practice" title="Your working goes here">
							The first problem arrives once the session opens.
						</EmptyState>
					)}

				</div>
				<footer className="pset" data-testid="practice-set">
					<span className="pset-l">This set</span>
					<ol className="pset-sq" aria-label="Problems in this set">
						{Array.from({ length: PRACTICE_SET_SIZE }, (_, i) => {
							const slot = slotOf(set[base + i]);
							return (
								<li key={i} className={slot.cls} title={`Problem ${i + 1} · ${slot.title}`} aria-label={`Problem ${i + 1}: ${slot.title}`}>
									{slot.cls === "ok" || slot.cls === "hint" ? <Icon name="check" size="xs" strokeWidth={3} /> : slot.cls === "miss" ? <Icon name="minus" size="xs" strokeWidth={3} /> : i + 1}
								</li>
							);
						})}
					</ol>
					{tokens > 0 && <span className="pset-tok mono num" title="Tokens used in this session">{formatTokens(tokens)} tok</span>}
				</footer>
			</div>
		</aside>
	);
}

// ─── The reading fold (Lesson4) ─────────────────────────────────────────────

export interface StepFold {
	/** The message index where the current step begins. */
	startIndex: number;
	/** Steps folded above it (the bar reads "Steps 1–n"). */
	steps: number;
	/** Graded check answers before it: total, and right first time. */
	answers: { total: number; firstTry: number };
	heading: { number: number; title: string } | null;
}

/** Pure: Lesson4's reading mode — only the current step stays on the page.
 *  The current step starts after the last message holding a check tagged
 *  to a DIFFERENT plan node (the teaching for the new node follows it);
 *  everything before folds into the "Steps 1–n" bar. Null before the plan
 *  places the learner anywhere (the check-in reads in full). A question can
 *  be answered once in this app, so "right first time" is the correct count
 *  (dismissals excluded, "I don't know" counted as not right). Exported for
 *  tests. */
export function stepFold(messages: readonly PopupMessage[], progress: PlanProgress | null): StepFold | null {
	if (!progress || progress.currentIndex === null) return null;
	const current = progress.steps[progress.currentIndex - 1]!;
	const ids = new Set(progress.steps.map((s) => s.id));
	let lastOther = -1;
	messages.forEach((m, i) => {
		for (const part of m.parts) {
			if (part.type !== "tool-quiz" && part.type !== "tool-explain") continue;
			const node = (part.input as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof node === "string" && ids.has(node) && node !== current.id) lastOther = i;
		}
	});
	const startIndex = lastOther + 1;
	let total = 0;
	let firstTry = 0;
	for (const m of messages.slice(0, startIndex)) {
		for (const part of m.parts) {
			if ((part.type !== "tool-quiz" && part.type !== "tool-probe") || part.state !== "output-available") continue;
			const out = part.output as { correct?: boolean; dismissed?: boolean } | undefined;
			if (!out || out.dismissed) continue;
			total += 1;
			if (out.correct === true) firstTry += 1;
		}
	}
	return {
		startIndex,
		steps: Math.max(0, progress.currentIndex - 1),
		answers: { total, firstTry },
		heading: { number: progress.currentIndex, title: current.title },
	};
}
