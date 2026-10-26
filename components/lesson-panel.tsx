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

import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { finishDictation, useDictationTarget, joinDictation } from "@/components/dictation";
import { JobsContext } from "@/components/jobs-context";
import { CONFIDENCE_LEVEL_COLORS } from "@/components/confidence-colors";
import { catalogLimits, useModelCatalog } from "@/components/model-picker";
import { latestTree, type PopupMessage } from "@/components/plan-block";
import { QuestionDock } from "@/components/question-dock";
import { ReadingThinkingField } from "@/components/reading-thinking";
import { formatTokens, planCostLabel } from "@/components/usage-format";
import { useChats } from "@/components/v4/data";
import { MicIcon } from "@/components/v4/icons";
import {
	CONFIDENCE_LEVELS,
	HINT_RUNGS,
	PRACTICE_SET_SIZE,
	confidenceLabel,
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
	dictationCancel,
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
	dictationCancel?: () => void;
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
		}
	}
	const revealPending = !!pending && requiresReveal && !revealed;

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
	const tabs: { id: Tab; label: string; badge?: string; dot?: boolean }[] = [
		{ id: "question", label: pending ? "Your turn" : questionTabLabel(pending), dot: !!pending },
		{ id: "path", label: "Path", badge: progress ? `${progress.currentIndex ?? progress.visited}/${progress.total}` : undefined },
		{ id: "helpers", label: "Helpers", badge: running ? String(running) : undefined },
	];

	return (
		<aside className="dock" aria-label="Question and lesson details" data-testid="lesson-panel">
			<div className={`dockin glass ${attn ? "attn" : ""}`} style={{ "--lh-prose-size": "15px" } as React.CSSProperties}>
				<div className="tabs" role="tablist">
					{tabs.map((t) => (
						<button key={t.id} type="button" role="tab" aria-selected={tab === t.id} className={tab === t.id ? "on" : ""} onClick={() => setTab(t.id)} data-testid={`lesson-tab-${t.id}`}>
							{t.label}
							{t.dot && <span className="ping" aria-label="waiting on you" />}
							{t.badge && (
								<span className="mono" style={{ fontSize: 11, color: "var(--v-muted)" }}>
									{t.badge}
								</span>
							)}
						</button>
					))}
				</div>

				{tab === "question" && (
					<div className="pane fade" role="tabpanel" style={{ "--dock-max-h": "none" } as React.CSSProperties}>
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
									onEscape={dictationCancel}
									dictationClaim={!revealPending}
									compactionRunning={compactionRunning}
								/>
								{requiresReveal && revealPending && (
									<ReadingThinkingField
										value={readingThinking}
										onChange={onReadingThinking}
										onEscape={dictationCancel}
										onOpen={() => void finishDictation().then(() => setRevealed(true))}
										claim={revealPending}
									/>
								)}
							</>
						) : answered ? (
							<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
								<div className="settle" style={{ padding: "10px 12px", borderRadius: 11, background: "var(--line)", display: "flex", flexDirection: "column", gap: 4 }}>
									<span style={{ fontSize: 11.5, fontWeight: 600, color: "var(--v-muted)" }}>
										{answered.questionType === "predict" ? "You predicted" : "You answered"}
										{answered.confidence !== undefined && ` · ${(confidenceLabel(answered.confidence) ?? `${answered.confidence}%`).toLowerCase()}`}
										{answered.correct === true ? " · right" : answered.correct === false ? " · not quite" : ""}
									</span>
									<span className="serif" style={{ fontSize: 14, lineHeight: "21px" }}>
										{answered.dontKnow
											? "I don’t know yet"
											: (answered.options?.filter((o) => answered.answers.some((a) => a.index === o.index)).map((o) => o.label).join("; ") || answered.text || answered.other || "")}
									</span>
								</div>
								{busy ? (
									<div className="settle" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
										<span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--v-accent)" }}>Tutor</span>
										<span style={{ fontSize: 12.5, color: "var(--v-muted)" }}>Replying in the lesson…</span>
										<span className="ind" aria-hidden="true">
											<i />
										</span>
									</div>
								) : (
									<span style={{ fontSize: 12.5, color: "var(--v-muted)" }}>The next check appears here when you reach it.</span>
								)}
							</div>
						) : (
							<span style={{ fontSize: 12.5, color: "var(--v-muted)" }}>
								{phase === "probe" ? "The check-in’s questions appear here." : "No question right now. Checks appear here as the lesson goes; ask or steer any time below."}
							</span>
						)}
					</div>
				)}

				{tab === "path" && (
					<div className="pane fade" role="tabpanel">
						{progress ? (
							<>
								<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
									<span style={{ fontSize: 12, color: "var(--v-muted)" }}>
										{progress.visited} of {progress.total} visited
										{progress.currentIndex !== null && ` · on step ${progress.currentIndex}`}
									</span>
									<button type="button" className="ghost" style={{ height: 28, fontSize: 12 }} onClick={onOpenPlan}>
										Open map
									</button>
								</div>
								<div className="pbar">
									<i style={{ transform: `scaleX(${(progress.visited / progress.total).toFixed(3)})` }} />
								</div>
								<ol style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 1 }} data-testid="path-steps">
									{progress.steps.map((st) => (
										<li key={st.id} className={`step ${st.status === "current" ? "c" : st.status === "visited" ? "d" : ""}`} data-status={st.status}>
											<i aria-hidden="true" />
											{st.title}
										</li>
									))}
								</ol>
							</>
						) : (
							<span style={{ fontSize: 12.5, color: "var(--v-muted)" }}>The path appears once the check-in finds where you are.</span>
						)}
					</div>
				)}

				{tab === "helpers" && (
					<div className="pane fade" role="tabpanel">
						{jobs.length === 0 && <span style={{ fontSize: 12.5, color: "var(--v-muted)" }}>Helpers research, build demos and draw figures when the lesson calls for one.</span>}
						{[...jobs].reverse().map((j) => (
							<div key={j.id} className="agent" style={j.status === "running" ? undefined : { opacity: 0.75 }}>
								<span style={{ display: "flex", justifyContent: "space-between" }}>
									<b style={{ fontWeight: 700 }}>{JOB_LABEL[j.kind]}</b>
									<span className="mono" style={{ fontSize: 11, color: j.status === "error" ? "#b3261e" : "var(--v-muted)" }}>
										{j.status === "running" ? elapsed(j.createdAt) : j.status === "done" ? "done" : "failed"}
									</span>
								</span>
								{j.activity && <span style={{ fontSize: 12, color: "var(--v-muted)" }}>{j.activity}</span>}
								{j.status === "running" && (
									<span className="ind" aria-hidden="true">
										<i />
									</span>
								)}
							</div>
						))}
						<LessonNumbers chatId={chatId} turns={turns} contextTokens={contextTokens} pricing={pricing} />
					</div>
				)}
			</div>
		</aside>
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
 *  cost — the context bar against the model's window. */
function LessonNumbers({ chatId, turns, contextTokens, pricing }: { chatId: string; turns: TurnUsage[]; contextTokens: number | null; pricing?: SessionPricing }) {
	const chats = useChats();
	const me = chats?.find((c) => c.id === chatId);
	const { catalog } = useModelCatalog();
	const model = turns.at(-1)?.model;
	const limit = model && catalog ? (catalogLimits(catalog).get(model) ?? null) : null;
	const tokens = sumTokens(turns);
	const rows: Array<[string, string]> = [
		["Time", me?.minutes !== undefined ? `${me.minutes} min` : "—"],
		["Answers", me?.answers ? `${me.answers.total} · ${me.answers.firstTry} first try` : "—"],
		["Context", `${contextTokens === null ? "?" : formatTokens(contextTokens)}${limit ? ` / ${formatTokens(limit)}` : ""}`],
		["Tokens", tokens > 0 ? formatTokens(tokens) : "—"],
		["Cost", lessonCostLabel(turns, pricing)],
	];
	return (
		<div style={{ display: "flex", flexDirection: "column", gap: 8, paddingTop: 6 }}>
			<span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)" }}>This lesson</span>
			<dl style={{ margin: 0, display: "grid", gridTemplateColumns: "1fr auto", gap: "6px 12px", fontSize: 12.5 }}>
				{rows.map(([k, v]) => (
					<div key={k} style={{ display: "contents" }}>
						<dt style={{ color: "var(--v-muted)" }}>{k}</dt>
						<dd className="mono" style={{ margin: 0 }}>
							{v}
						</dd>
					</div>
				))}
			</dl>
			{limit && contextTokens !== null && (
				<div className="pbar">
					<i style={{ transform: `scaleX(${Math.min(1, contextTokens / limit).toFixed(3)})` }} />
				</div>
			)}
		</div>
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


/**
 * THE PRACTICE DOCK (Practice4): your working for the open problem — the
 * field (with dictation), how sure, the hint ladder, submit — and then the
 * set. A hint request rides the thinking lane with its rung (the server
 * makes the request explicit to the agent; the doctrine's ladder decides
 * what the hint says).
 */
export function PracticePanel({
	messages,
	practice,
	onSubmitThinking,
	compactionRunning,
	dictationCancel,
	turns,
	hintsUsed,
}: {
	messages: readonly PopupMessage[];
	practice: { toolCallId: string; input: unknown } | null;
	onSubmitThinking: (text: string, hint?: HintRung) => void;
	compactionRunning: boolean;
	dictationCancel?: () => void;
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
	useDictationTarget((t: string) => setText(joinDictation(draftRef.current, t)), !!practice);
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

	return (
		<aside className="dock full" aria-label="Your working" data-testid="practice-panel">
			<div className="dockin glass" style={{ padding: 16, gap: 14, overflow: "auto" }}>
				{practice ? (
					<div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
						<label htmlFor="work" style={{ fontWeight: 700 }}>
							Your working
						</label>
						<div style={{ position: "relative" }}>
							<textarea
								id="work"
								rows={7}
								className="serif"
								value={draft}
								data-testid="practice-thinking-field"
								onChange={(e) => setText(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === "Escape" && dictationCancel) {
										e.stopPropagation();
										dictationCancel();
									} else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
										e.preventDefault();
										submit();
									}
								}}
								placeholder="Think out loud. Hints read your working; Submit ends the problem."
								style={{ width: "100%", display: "block", padding: "10px 40px 10px 12px", borderRadius: 11, border: "1px solid var(--line)", background: "var(--v-input)", resize: "vertical", fontSize: 14.5, lineHeight: "22px", outline: "none" }}
							/>
							<span style={{ position: "absolute", right: 6, bottom: 6, color: "var(--v-muted)" }} aria-hidden="true">
								<MicIcon />
							</span>
						</div>
						<div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
							<span id="sure" style={{ fontSize: 12, fontWeight: 600 }}>
								How sure?
							</span>
							<div className="seg conf" role="radiogroup" aria-labelledby="sure">
								{CONFIDENCE_LEVELS.map((l) => (
									<button
										key={l.value}
										type="button"
										role="radio"
										aria-checked={conf === l.value}
										className={conf === l.value ? "on" : ""}
										onClick={() => setConf(l.value)}
										style={{ "--lvl": CONFIDENCE_LEVEL_COLORS[l.value]!.ink, "--lvl-soft": CONFIDENCE_LEVEL_COLORS[l.value]!.soft } as React.CSSProperties}
									>
										{l.label}
									</button>
								))}
							</div>
						</div>
						<div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "10px 12px", borderRadius: 11, background: "var(--line)" }}>
							<span style={{ display: "flex", justifyContent: "space-between", fontSize: 12 }}>
								<b style={{ fontWeight: 600 }}>Hints</b>
								<span style={{ color: "var(--v-muted)" }}>{hintsUsed === 0 ? "none used" : `${hintsUsed} of ${HINT_RUNGS.length} used`}</span>
							</span>
							<span style={{ display: "flex", gap: 4 }} aria-hidden="true">
								{HINT_RUNGS.map((r, i) => (
									<span key={r.rung} className={`rung ${i < hintsUsed ? "on" : ""}`} />
								))}
							</span>
							<button type="button" className="ghost tall" style={{ marginTop: 4 }} disabled={compactionRunning || hintsUsed >= HINT_RUNGS.length} onClick={askHint} data-testid="practice-hint">
								{hintsUsed >= HINT_RUNGS.length ? "No more hints" : `Ask for a ${HINT_RUNGS[nextRung - 1]!.label.toLowerCase()}`}
							</button>
						</div>
						<button type="button" className="btn tall" disabled={!draft.trim() || compactionRunning} onClick={submit} data-testid="practice-send">
							Submit answer
						</button>
					</div>
				) : (
					<div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
						<span style={{ fontSize: 12, fontWeight: 700, color: "var(--v-muted)" }}>
							{set.length > 0 ? `Problem ${set.length} done` : "Your working"}
						</span>
						<span style={{ fontSize: 12.5, color: "var(--v-muted)" }}>
							{set.length > 0 ? "Press Enter in the box below for the next problem, or ask about the last one." : "The first problem arrives once the session opens."}
						</span>
					</div>
				)}
				<div style={{ marginTop: "auto", display: "flex", flexDirection: "column" }} data-testid="practice-set">
					<span style={{ fontSize: 11.5, fontWeight: 700, color: "var(--faint)", paddingBottom: 4 }}>This set</span>
					{Array.from({ length: Math.max(PRACTICE_SET_SIZE, set.length % PRACTICE_SET_SIZE === 0 && set.length ? PRACTICE_SET_SIZE : set.length) }, (_, i) => {
						const base = Math.floor(Math.max(0, set.length - 1) / PRACTICE_SET_SIZE) * PRACTICE_SET_SIZE;
						const p = set[base + i];
						const working = p && p.outcome === null;
						const label = !p ? "—" : working ? "Working" : p.outcome === "solved" ? "Solid" : p.outcome === "solvedWithHints" ? "With help" : p.outcome === "dismissed" ? "Skipped" : "Moved on";
						const cls = !p || working ? "" : p.outcome === "solved" ? "solid" : p.outcome === "solvedWithHints" ? "help" : "miss";
						return (
							<div key={i} className="prob">
								<span style={{ flex: 1, fontWeight: working ? 700 : 500 }}>Problem {i + 1}</span>
								{cls ? <span className={`pill ${cls}`}>{label}</span> : <span style={{ fontWeight: working ? 700 : 500, color: working ? "var(--ink)" : "var(--v-muted)" }}>{label}</span>}
							</div>
						);
					}).slice(0, PRACTICE_SET_SIZE)}
					<span className="mono" style={{ paddingTop: 8, fontSize: 11, color: "var(--faint)" }}>
						{tokens > 0 ? `${formatTokens(tokens)} tokens this session` : " "}
					</span>
				</div>
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
