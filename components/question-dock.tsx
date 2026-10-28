"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { finishDictation, isDictationActive, joinDictation, useDictationTarget } from "@/components/dictation";
import { useEnterSubmits } from "@/components/enter-submits";
import { MessageResponse } from "@/components/ai-elements/message";
import { MathLine } from "@/components/latex-glyph";
import { ConfidenceLadder } from "@/components/confidence-rail";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import {
	buildAnswer,
	normalizeQuizType,
	CONFIDENCE_LEVELS,
	kbdEventForAction,
	emptyDockSelection,
	normalizeOptions,
	resolveCorrect,
	seededRandom,
	shuffleOptions,
	toolQuestionKind,
	parseAskInput,
	parseQuizInput,
	parseExplainInput,
	plainText,
	toggleOption,
	toggleOther,
	type AnswerRequest,
	type AskToolInput,
	type DockSelection,
	type ExplainToolInput,
	type QuestionAnswerData,
	type QuestionData,
	type QuestionMode,
	type QuizToolInput,
	type SelectMode,
	type Phase3,
} from "@/src/core";

/**
 * The question dock — a pending quiz/ask REPLACES the chat composer: the
 * persistent bottom blob morphs into the question. Two voices meet here:
 * the teacher's (question, options, explanation) and the learner's —
 * "Your thinking", a labeled composer-twin field for dumping reasoning,
 * with Submit docked inside it exactly like the chat composer's send.
 *
 * The thinking field is the transfer channel of the whole product (wave-2):
 * never called "optional", Enter makes a NEWLINE (it is for dumping — soon
 * dictated, not typed), submission is the button only, and its size scales
 * with the phase (probing stays quick; teaching invites depth). The
 * "Other…" option is an editable option ROW — circle + inline input,
 * styled like its siblings — so picking Other never displaces thinking.
 *
 * Collapse behavior (scroll-up → slim bar) is owned by the DockOverlay in the
 * chat view, which also owns the persistent shell and its height morph. This
 * component is content only. The expanded form stays MOUNTED while collapsed
 * (hidden, not unmounted) so a half-made selection survives scrolling.
 */

export interface QuestionDockProps {
	toolName: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
	toolCallId: string;
	input: QuizToolInput | AskToolInput | ExplainToolInput;
	/** Collapse state, owned by the DockOverlay (it drives the shell's height morph). */
	expanded: boolean;
	/**
	 * Teach-phase check awaiting its reveal (vision §2, W5): while collapsed,
	 * the bar is the "Check your understanding" invitation instead of the
	 * scroll-collapse strip. Owned by the DockOverlay; false once the learner
	 * has revealed (afterwards the normal collapse machine rules apply).
	 */
	reveal?: boolean;
	onExpand: () => void;
	onSubmit: (output: QuestionAnswerData) => void;
	/** Escape in a question field stops dictation (STT wave) — threaded
	 *  from the page that owns the dictation hook. */
	onEscape?: () => void;
	/** The keyboard machine (wave B) is armed only while the dock is
	 *  expanded — the collapsed bar keeps its native Enter-to-expand. */
	active?: boolean;
	/** Session phase at the question — scales the thinking field: probing
	 *  stays quick (one row), teaching invites dumping (three rows). */
	phase?: Phase3;
	/** Dictation claim (owner 2026-10-03): false while a teach-phase check
	 *  sits UNREVEALED — the reading-thinking field owns dictated speech
	 *  during the reading; the dock reclaims on reveal. Default true (probe
	 *  questions, predictions, old callers). */
	dictationClaim?: boolean;
	/** Compaction is running for this chat (owner round 14): the answer
	 *  POST would block on the server's compaction gate — disable submit
	 *  and say so in the hint row. The server registry is the real gate;
	 *  this is the affordance. */
	compactionRunning?: boolean;
}

export function QuestionDock({
	toolName,
	toolCallId,
	input,
	expanded,
	reveal = false,
	onExpand,
	onSubmit,
	onEscape,
	phase = "probe",
	dictationClaim = true,
	compactionRunning = false,
}: QuestionDockProps) {
	// The probe-phase names (owner, 2026-10-09) canonicalize onto their
	// teach twins for every dock concern — parse dispatch, labels, kinds:
	// the probe quiz ("probe") is quiz-shaped, the probe free-recall
	// ("recall") is explain-shaped. Old records keep the teach names.
	const canonical =
		toolName === "probe" ? "quiz" : toolName === "recall" ? "explain" : toolName;
	// The chip's display name carries the tool's OWN name (owner
	// 2026-10-09): probe-phase questions label Probe/Recall in the
	// composer; teach tools keep the standing labels.
	const toolLabel = toolName === "probe" ? "Probe" : toolName === "recall" ? "Recall" : undefined;
	// Parse, don't cast (src/core/tool-parts.ts): the model authored this
	// input, and only the schema the tool declared vouches for its shape.
	// The dock mounts on input-available parts (already validated at the
	// bridge), so this is pure defense in depth — but it is STRUCTURAL now:
	// anything that slips through renders the quiet fallback, never a
	// crash on `.map` over model-authored bytes.
	const parsed =
		canonical === "quiz" ? parseQuizInput(input) : canonical === "explain" ? parseExplainInput(input) : parseAskInput(input);
	if (!parsed) {
		return (
			<div data-testid="malformed-question" className="qmalformed">
				<Icon name="status-warn" size="sm" />
				This question arrived malformed — the transcript keeps the retry.
			</div>
		);
	}
	return (
		<>
			{!expanded && (
				<QuestionDockBar
					toolName={canonical}
					question={parsed.question}
					onExpand={onExpand}
					variant={reveal ? "reveal" : "collapsed"}
					toolLabel={toolLabel}
					label={
						(canonical === "quiz" || canonical === "explain") &&
						normalizeQuizType((parsed as { type?: unknown }).type) === "predict"
							? "Prediction"
							: undefined
					}
				/>
			)}
			<div className={expanded ? "dock-variant" : "invisible h-0 overflow-hidden"}>
				<QuestionDockForm
					toolName={toolName}
					toolCallId={toolCallId}
					input={parsed}
					phase={phase}
					active={expanded}
					onSubmit={onSubmit}
					onEscape={onEscape}
					dictationClaim={dictationClaim}
					compactionRunning={compactionRunning}
				/>
			</div>
		</>
	);
}

/** The collapsed strip. Two species (W5): "collapsed" is the scroll minimization
 *  (kind chip + one-liner + Answer); "reveal" is the teach-check invitation —
 *  a distinct, more inviting affordance, because it asks the learner to start
 *  something, not to resume something. */
/** The collapsed bar's teaser: plainText's rules, uncapped (CSS clamps) —
 *  math stays for MathLine (owner ruling 2026-10-28). */
function teaserText(q: string): string {
	return plainText(q, Infinity) ?? "";
}

export function QuestionDockBar({
	toolName,
	question,
	onExpand,
	variant = "collapsed",
	label,
	toolLabel,
}: {
	toolName: "quiz" | "ask_user_question" | "explain";
	question: string;
	onExpand: () => void;
	variant?: "collapsed" | "reveal";
	/** The kind chip's text (owner 2026-10-03): "Prediction" when a
	 *  predict-type quiz minimizes by scroll — predictions never use the
	 *  reveal variant, but the scroll-collapse strip can still hide them. */
	label?: string;
	/** The chip's TOOL display name (owner 2026-10-09): probe-phase calls
	 *  label Probe/Recall — the phase boundary visible in the composer. */
	toolLabel?: string;
}) {
	if (variant === "reveal") {
		return (
			<button type="button" data-testid="teach-check-reveal" onClick={onExpand} className="qreveal dock-variant">
				<span className="qreveal-ic" aria-hidden="true">
					<Icon name="ask" size="md" />
				</span>
				<span className="qreveal-tx">
					<span className="qreveal-t">Check your understanding</span>
					<span className="qreveal-d"><MathLine text={teaserText(question)} /></span>
				</span>
				<span className="qreveal-go">
					Open
					<Icon name="chevron-right" size="sm" />
				</span>
			</button>
		);
	}
	return (
		<button type="button" data-testid="question-dock-bar" onClick={onExpand} className="qbar dock-variant">
			<span className="qbar-k">{label ?? toolLabel ?? (toolName === "quiz" ? "Check" : toolName === "explain" ? "Explain" : "Question")}</span>
			<span className="qbar-q"><MathLine text={teaserText(question)} /></span>
			<span className="qbar-go">
				Answer
				<Icon name="arrow-down" size="sm" />
			</span>
		</button>
	);
}

/** The expanded question: label, question, options, and the unified bottom row. */
function QuestionDockForm({
	toolName,
	toolCallId,
	input,
	phase = "probe",
	active,
	onSubmit,
	onEscape,
	dictationClaim = true,
	compactionRunning = false,
}: Omit<QuestionDockProps, "expanded" | "onExpand" | "reveal">) {
	const kind = toolQuestionKind(toolName);

	// Canonical QuestionData, built once per question. Quiz options are
	// deterministically shuffled (seeded by toolCallId) so position never leaks
	// correctness AND server/client render the same order (hydration-safe);
	// the display order is snapshotted into the answer record at submit time.
	const qd = useMemo<QuestionData>(() => {
		const quizInput = kind === "quiz" ? (input as QuizToolInput) : null;
		const askInput = kind === "ask" ? (input as AskToolInput) : null;
		const explainInput = kind === "explain" ? (input as ExplainToolInput) : null;
		const multi = input instanceof Object && "multiSelect" in input ? input.multiSelect === true : false;
		const mode: QuestionMode =
			kind === "quiz"
				? multi
					? "multi-select"
					: "single-select"
				: askInput?.options?.length
					? multi
						? "multi-select"
						: "single-select"
						: "text";
		const options = normalizeOptions(
			(quizInput?.options ?? askInput?.options ?? []) as { label: string; value?: string }[],
		);
		const ordered = kind === "quiz" && options.length > 0 ? shuffleOptions(options, seededRandom(toolCallId)) : options;
		const q: QuestionData = {
			id: toolCallId,
			kind,
			// The role (owner 2026-10-03): predict questions gate by it in the
			// view (never collapsed) and the answered card tucks the explanation.
			questionType: kind === "quiz" ? normalizeQuizType((input as { type?: unknown }).type) : undefined,
			question: input.question,
			context: input.details,
			mode,
			options: ordered,
			createdAt: new Date().toISOString(),
		};
		if (quizInput) {
			const resolved = resolveCorrect(quizInput.correctAnswer, ordered);
			if (resolved.error) console.error("[quiz] correctAnswer did not resolve:", resolved.error);
			q.correctIndices = resolved.indices;
			q.explanation = quizInput.explanation;
		}
		if (explainInput) {
			// The commitment rides the question data (never sent to the
			// client before answering) and snapshots into the answer at submit.
			// One field, reasoning included — no separate explanation
			// (owner ruling 2026-09-27).
			q.committedAnswer = explainInput.correctAnswer;
		}
		return q;
	}, [toolCallId, kind, input]);

	// The selection state machine lives in question-core (pure, tested):
	// single-select displaces, multi-select coexists — picking the ask
	// "Other…" row in a multi-select must never clear already-picked
	// options, and picking an option must never clear a typed custom answer.
	const [sel, setSel] = useState<DockSelection>(emptyDockSelection());
	// The learner's transfer channel — thinking, never "a note".
	const [thinking, setThinking] = useState("");
	const [other, setOther] = useState("");
	const [text, setText] = useState("");
	/* Refs MIRROR the two dictation-target fields ("nothing gets lost"
	 * round, owner 2026-10-01): the run's flush lands via setState, which
	 * a closure waiting through `await finishDictation()` cannot observe
	 * in time — submit reads these, kept current at every write site. */
	const thinkingTextRef = useRef("");
	const answerTextRef = useRef("");
	// Confidence (owner, 2026-10-01; v4 four levels 2026-10-26): an index
	// into CONFIDENCE_LEVELS, resting at "Unsure" (50) — a real coin flip by
	// definition, untouched or deliberate (the same number, the same
	// meaning). The dock unmounts between questions, so each starts fresh.
	const [confIdx, setConfIdx] = useState<number>(1);
	const selectMode: SelectMode = qd.mode === "multi-select" ? "multi-select" : "single-select";

	// The PRIMARY dictation input (owner, STT round 1): while a question
	// waits, dictated finals land HERE, never in the hidden composer — text
	// mode owns "Your answer", select modes own "Your thinking". The claim
	// is effect-scoped, so the question unmounting releases it and
	// dictation falls back to the composer automatically.
	useDictationTarget(
		useCallback(
			(t: string) => {
				// Ref-first (see the refs block above): the join is computed from
				// the mirror, then both mirrors agree with state — a submit
				// resuming post-finish reads the tail, never a stale closure.
				if (qd.mode === "text") {
					const v = joinDictation(answerTextRef.current, t);
					answerTextRef.current = v;
					setText(v);
				} else {
					const v = joinDictation(thinkingTextRef.current, t);
					thinkingTextRef.current = v;
					setThinking(v);
				}
			},
			[qd.mode],
		),
		// Released while a teach check sits unrevealed (owner 2026-10-03):
		// the reading-thinking field owns dictated speech during the reading.
		dictationClaim,
	);

	const toggle = (idx: number) => setSel(toggleOption(selectMode, sel, idx));

	const canSubmit =
		qd.mode === "text"
			? text.trim().length > 0
			: sel.dontKnow || (sel.otherSelected && other.trim().length > 0) || sel.selected.size > 0;

	const submit = () => {
		if (!canSubmit || compactionRunning) return;
		/* FINISH DICTATION FIRST (owner, 2026-10-01): Enter may arrive while
		 * a run is live with reasoning still in Deepgram's hands. Stop the
		 * run, let the last finals land in the target field, and only then
		 * build the answer — the spoken reasoning is never lost to a
		 * forgotten stop. The field values below come from the REF mirrors
		 * because the flush lands via setState after an await. */
		if (!isDictationActive()) {
			doSubmit();
			return;
		}
		void finishDictation().then(doSubmit);
	};
	const doSubmit = () => {
		if (!canSubmit) return;
		const req: AnswerRequest = {
			dontKnow: sel.dontKnow,
			values: [...sel.selected].map((i) => qd.options[i]!.value),
			other: sel.otherSelected ? other : undefined,
			text: qd.mode === "text" ? answerTextRef.current : undefined,
			thinking: qd.mode !== "text" ? thinkingTextRef.current.trim() || undefined : undefined,
			// Always sent on quiz answers (owner: 50 must mean 50, never
			// "untouched"); buildAnswer drops it on "I don't know".
			confidence: kind === "quiz" ? CONFIDENCE_LEVELS[confIdx]!.value : undefined,
		};
		onSubmit(buildAnswer(qd, req, toolName));
	};

	/* ENTER SUBMITS FROM ANYWHERE (owner round 6, 2026-10-05): the same
	 * law as the practice dock — dictated answers rarely focus the field.
	 * Rides submit() so the dictation-flush law is shared, not forked. */
	useEnterSubmits(submit);

	// Selecting Other never clears the thinking field — two channels, the
	// answer and the reasoning behind it, side by side.
	const selectOther = () => setSel(toggleOther(selectMode, sel));

	/* ── The keyboard machine (shortcut wave B, owner rounds 2026-09-17) ──
	   ↑/↓ walk EVERY answerable row in order — options first, then the
	   quiz's "I don't know" or the ask's "Other…" (whichever exists) —
	   CLAMPED at the ends, no wrap (owner: faster to navigate when the
	   walk stops at the last row). Space acts on the walked row exactly
	   like a click (multi toggles, single displaces; Other also focuses
	   its input for typing), Enter submits once an answer exists.
	   Tab toggles FOCUS between the thinking field and the answer rows
	   (owner round 3) — nothing else; Shift+Tab is NOT ours (the global
	   thinking-level cycle owns it). Two guards keep native behavior
	   intact: keys from a TYPING SURFACE keep their meaning (arrows move
	   the caret, space types), and modifier combos are never ours
	   (Alt+arrows cycle sessions — they must not ALSO walk the rows).
	   The listener is document-level and lives only while the dock is
	   expanded — collapsed, the bar's native Enter expands it. */
	const [kbdIdx, setKbdIdx] = useState<number | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const otherInputRef = useRef<HTMLInputElement>(null);
	const thinkingRef = useRef<HTMLTextAreaElement>(null);
	// One row past the options is the trailing row: quiz → don't-know,
	// ask → Other (a question never has both). Text mode (ask/explain)
	// has no rows — the composer IS the answer surface.
	const optionCount = qd.mode === "text" ? 0 : qd.options.length;
	const rowCount = qd.mode === "text" ? 0 : optionCount + 1;

	const kbdAct = (idx: number) => {
		if (idx < optionCount) toggle(idx);
		else if (kind === "quiz")
			setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }));
		else {
			// Space on the ask's Other row (owner refinement round,
			// 2026-09-24): SELECTING it focuses the input for typing, but
			// the Space that DESELECTS an already-selected Other must never
			// drop the user back into the typing field — the core's
			// toggleOther has no single-select off-path (it displaces), so
			// the off-path lives here: clear the pick, keep the typed text,
			// focus stays where it is. Re-selecting is the way back into
			// the field.
			if (sel.otherSelected) setSel((prev) => ({ ...prev, otherSelected: false, dontKnow: false }));
			else {
				otherInputRef.current?.focus();
				selectOther();
			}
		}
	};

	// Focus the walked row's focusable element — the Other row is a div,
	// so its inline input is the focus target there.
	const focusRow = (idx: number) => {
		const row = rootRef.current?.querySelector(`[data-kbdrow="${idx}"]`) as HTMLElement | null;
		if (!row) return;
		const el = (row.querySelector("input") as HTMLElement | null) ?? row;
		el.focus();
	};

	useEffect(() => {
		if (!active || rowCount === 0) return;
		const onKeyDown = (e: KeyboardEvent) => {
			const t = e.target as HTMLElement | null;
			// A TYPING field is where keys mean text (owner round 4): the
			// thinking/answer fields, search boxes, renames — never a range
			// input, whose focus after a click or drag must not kill the
			// arrow cycling. Everywhere else the arrows act.
			const typing =
				!!t &&
				((t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable);
			// Alt/Cmd/Ctrl combos are never ours (Alt+arrows cycle sessions
			// globally — they must not ALSO walk the question rows).
			const modded = e.altKey || e.metaKey || e.ctrlKey;
			// Plain Tab toggles focus: rows → thinking. The confidence
			// slider takes NO focus at all (owner, UI round 2026-10-01) —
			// global ←/→ own its keyboard, so it never joins the chain.
			// Shift+Tab falls through (the global thinking-level cycle owns
			// it), so the shift check matters.
			if (e.key === "Tab" && !e.shiftKey && !modded) {
				e.preventDefault();
				e.stopPropagation();
				if (t?.closest?.("[data-kbdrow]")) thinkingRef.current?.focus();
				else {
					const idx = kbdIdx ?? 0;
					setKbdIdx(idx);
					focusRow(idx);
				}
				return;
			}
			// Keys from a typing surface keep their meaning (arrows move
			// the caret, space types).
			if (typing || modded) return;
			// Lesson4's "1–4 pick": a digit acts on that row (the trailing
			// "I don't know" / Other row is the number after the options).
			if (/^[1-9]$/.test(e.key)) {
				const idx = Number(e.key) - 1;
				if (idx < rowCount) {
					e.preventDefault();
					setKbdIdx(idx);
					kbdAct(idx);
				}
				return;
			}
			if (e.key === "ArrowDown") {
				e.preventDefault();
				const next = Math.min((kbdIdx ?? -1) + 1, rowCount - 1);
				setKbdIdx(next);
				// Focus follows the walk while the user is IN the rows (Tab
				// put them there) so focused and walked never diverge.
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				const next = Math.max((kbdIdx ?? rowCount) - 1, 0);
				setKbdIdx(next);
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				// Global confidence cycling (owner, UI round 2026-10-01): the
				// SAME pattern as ↑/↓ over the rows — works wherever focus
				// sits, no click-in, no focus ring. Dead on "I don't know"
				// (the slider grays out and nothing is sent).
				if (kind !== "quiz" || sel.dontKnow) return;
				e.preventDefault();
				setConfIdx((i) =>
					Math.min(
						CONFIDENCE_LEVELS.length - 1,
						Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)),
					),
				);
			} else if (e.key === " ") {
				if (kbdIdx === null) return; // plain Space keeps scrolling the page
				e.preventDefault();
				kbdAct(kbdIdx);
			} else if (e.key === "Enter") {
				if (kbdIdx === null || !canSubmit) return;
				e.preventDefault();
				submit();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	});

	// Keep the walked row visible (the question area scrolls internally).
	useEffect(() => {
		if (kbdIdx === null) return;
		rootRef.current
			?.querySelector(`[data-kbdrow="${kbdIdx}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [kbdIdx]);

	// Lesson4's question: the kind, the serif question, numbered choice
	// cards, how sure, the thinking field with its mic, then submit.
	const toggleDictation = () => window.dispatchEvent(new CustomEvent(kbdEventForAction("toggle-dictation")));
	const keyBadge = (i: number) => (
		<span className="k" aria-hidden="true">
			{i + 1}
		</span>
	);
	const kindLabel =
		toolName === "probe"
			? "Probe"
			: toolName === "recall"
				? "Recall"
				: kind === "quiz"
					? qd.questionType === "predict"
						? "Predict before you read on"
						: "Check"
					: kind === "explain"
						? "Explain"
						: "Question";
	const fieldId = `${toolCallId}-field`;
	return (
		<div ref={rootRef} data-testid="question-dock" className="qform">
			<div data-session-find-root="" className="qbody">
				<div className="qhead">
					<span className="qkind">
						{kindLabel}
						{qd.mode === "multi-select" && <span className="qkind-note"> · select all that apply</span>}
					</span>
					<div className="qtext">
						<MessageResponse>{qd.question}</MessageResponse>
					</div>
				</div>
				{qd.context && (
					<div className="qctx">
						<MessageResponse>{qd.context}</MessageResponse>
					</div>
				)}

				{qd.mode !== "text" && (
					<div className="opts" role={qd.mode === "multi-select" ? "group" : "radiogroup"}>
						{qd.options.map((opt, i) => {
							const isSel = sel.selected.has(i);
							const dim = !isSel && (sel.selected.size > 0 || sel.dontKnow) && qd.mode !== "multi-select";
							return (
								<button
									key={opt.value}
									type="button"
									role={qd.mode === "multi-select" ? "checkbox" : "radio"}
									aria-checked={isSel}
									data-kbdrow={i}
									onClick={() => toggle(i)}
									className={cn("opt", isSel && "sel", dim && "dim", i === kbdIdx && !isSel && "at")}
								>
									{keyBadge(i)}
									<span className="opt-tx">
										<MessageResponse>{opt.label}</MessageResponse>
										{kind !== "quiz" && opt.description && (
											// QUIZ options render NO description (owner ruling
											// 2026-09-26): the model used them to telegraph
											// correctness. Descriptions are full markdown.
											<MessageResponse className="lh-prose opt-desc">{opt.description}</MessageResponse>
										)}
									</span>
								</button>
							);
						})}

						{kind === "quiz" && (
							<button
								type="button"
								onClick={() => setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }))}
								data-kbdrow={optionCount}
								aria-pressed={sel.dontKnow}
								className={cn("opt idk", sel.dontKnow && "sel", optionCount === kbdIdx && !sel.dontKnow && "at")}
							>
								{keyBadge(optionCount)}
								<span className="opt-tx">I don’t know yet</span>
							</button>
						)}

						{kind === "ask" && (
							<div
								role={qd.mode === "multi-select" ? "checkbox" : "radio"}
								aria-checked={sel.otherSelected}
								data-testid="other-option"
								data-kbdrow={optionCount}
								onClick={selectOther}
								className={cn("opt other", sel.otherSelected ? "sel" : "idk", optionCount === kbdIdx && !sel.otherSelected && "at")}
							>
								{keyBadge(optionCount)}
								<input
									ref={otherInputRef}
									value={other}
									onChange={(e) => {
										setOther(e.target.value);
										// Typing selects the row — displacing in single-select.
										setSel((prev) => (prev.otherSelected ? prev : toggleOther(selectMode, prev)));
									}}
									onKeyDown={(e) => {
										// Esc leaves the typing (the row stays selected); the
										// window chain must not read it as abort-turn.
										if (e.key === "Escape") {
											e.preventDefault();
											e.stopPropagation();
											e.currentTarget.blur();
											setKbdIdx(optionCount);
										}
										// Enter submits: a one-line field has no newline to protect.
										if (e.key === "Enter") {
											e.preventDefault();
											submit();
										}
									}}
									placeholder="Type your own answer…"
									className="opt-in"
									onClick={(e) => e.stopPropagation()}
								/>
							</div>
						)}
					</div>
				)}
			</div>

			{/* How sure (owner, 2026-10-01; v4 four levels): the learner's stated
			    probability that the selected answer is correct. Global ←/→ move
			    it; "I don't know" greys it out and nothing is sent. */}
			{kind === "quiz" && (
				<div className="qfield">
					<span id={`${toolCallId}-confidence`} className={cn("flabel", sel.dontKnow && "off")}>
						How sure are you?
					</span>
					<ConfidenceLadder
						value={CONFIDENCE_LEVELS[confIdx]!.value}
						onChange={(v) => setConfIdx(CONFIDENCE_LEVELS.findIndex((l) => l.value === v))}
						disabled={sel.dontKnow}
						labelledBy={`${toolCallId}-confidence`}
						title="How likely your answer is right. Adjust with ←/→."
						testid="confidence-control"
						stopTestids
					/>
				</div>
			)}

			{/* The learner's own words: "Your thinking" beside the options
			    (Enter submits, ⇧↵ newline), or "Your answer" in text mode. */}
			<form
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
				className="qanswer"
			>
				<div className="qfield" data-testid={qd.mode === "text" ? "answer-field" : "thinking-field"}>
					<label className="flabel" htmlFor={fieldId}>
						{qd.mode === "text" ? "Your answer" : "Your thinking"}
					</label>
					<div className="fwrap">
						{qd.mode === "text" ? (
							<textarea
								id={fieldId}
								value={text}
								onChange={(e) => {
									answerTextRef.current = e.target.value;
									setText(e.target.value);
								}}
								onKeyDown={(e) => {
									if (e.key === "Escape" && onEscape) {
										e.preventDefault();
										e.stopPropagation();
										onEscape();
										return;
									}
									if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
										e.preventDefault();
										submit();
									}
								}}
								placeholder="Your answer, in your own words…"
								rows={4}
								className="ftext"
							/>
						) : (
							<textarea
								id={fieldId}
								ref={thinkingRef}
								value={thinking}
								onChange={(e) => {
									thinkingTextRef.current = e.target.value;
									setThinking(e.target.value);
								}}
								onKeyDown={(e) => {
									if (e.key === "Escape" && onEscape) {
										e.preventDefault();
										e.stopPropagation();
										onEscape();
										return;
									}
									// THE STANDARD CHORD: Enter submits, Shift+Enter is a newline.
									if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
										e.preventDefault();
										submit();
									}
								}}
								placeholder="Why this answer? Whatever comes to mind."
								rows={phase === "teach" ? 3 : 2}
								className={cn("ftext", phase === "teach" ? "tall" : "short")}
							/>
						)}
						<button type="button" className={cn("ib sm fmic", isDictationActive() && "on")} aria-label="Dictate" onClick={toggleDictation}>
							<Icon name="mic" size="sm" />
						</button>
					</div>
				</div>
			</form>
			<div className="qfoot">
				<button type="button" className="btn brand lg qsubmit" onClick={submit} disabled={!canSubmit || compactionRunning}>
					Submit
				</button>
				<span className="qkeys">
					{compactionRunning ? (
						"Compacting the session…"
					) : qd.mode === "text" ? (
						"↵ submits · ⇧↵ newline"
					) : (
						<>
							<span className="kbd">1</span>–<span className="kbd">{rowCount}</span> pick · {"↵ submits · ⇧↵ newline"}
						</>
					)}
				</span>
			</div>
		</div>
	);
}
