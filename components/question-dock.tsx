"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
	DictationErrorLine,
	DictationMic,
	finishDictation,
	isDictationActive,
	joinDictation,
	useDictationState,
	useDictationTarget,
} from "@/components/dictation";
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

export interface QuestionDockProps {
	toolName: "quiz" | "probe" | "ask_user_question" | "explain" | "recall";
	toolCallId: string;
	input: QuizToolInput | AskToolInput | ExplainToolInput;
	expanded: boolean;
	reveal?: boolean;
	onExpand: () => void;
	onSubmit: (output: QuestionAnswerData) => void;
	onEscape?: () => void;
	active?: boolean;
	phase?: Phase3;
	dictationClaim?: boolean;
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
	const canonical =
		toolName === "probe" ? "quiz" : toolName === "recall" ? "explain" : toolName;
	const toolLabel = toolName === "probe" ? "Probe" : toolName === "recall" ? "Recall" : undefined;
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
	label?: string;
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
			q.committedAnswer = explainInput.correctAnswer;
		}
		return q;
	}, [toolCallId, kind, input]);

	const [sel, setSel] = useState<DockSelection>(emptyDockSelection());
	const [thinking, setThinking] = useState("");
	const [other, setOther] = useState("");
	const [text, setText] = useState("");
	const thinkingTextRef = useRef("");
	const answerTextRef = useRef("");
	const [confIdx, setConfIdx] = useState<number>(1);
	const selectMode: SelectMode = qd.mode === "multi-select" ? "multi-select" : "single-select";

	const isTarget = useDictationTarget(
		useCallback(
			(t: string) => {
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
		dictationClaim,
	);
	const dictationPhase = useDictationState().phase;
	const dictating = isTarget && dictationPhase !== "idle";

	const toggle = (idx: number) => setSel(toggleOption(selectMode, sel, idx));

	const canSubmit =
		qd.mode === "text"
			? text.trim().length > 0
			: sel.dontKnow || (sel.otherSelected && other.trim().length > 0) || sel.selected.size > 0;

	const submit = () => {
		if (!canSubmit || compactionRunning) return;
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
			confidence: kind === "quiz" ? CONFIDENCE_LEVELS[confIdx]!.value : undefined,
		};
		onSubmit(buildAnswer(qd, req, toolName));
	};

	useEnterSubmits(submit);

	const selectOther = () => setSel(toggleOther(selectMode, sel));

	const [kbdIdx, setKbdIdx] = useState<number | null>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const otherInputRef = useRef<HTMLInputElement>(null);
	const thinkingRef = useRef<HTMLTextAreaElement>(null);
	const optionCount = qd.mode === "text" ? 0 : qd.options.length;
	const rowCount = qd.mode === "text" ? 0 : optionCount + 1;

	const kbdAct = (idx: number) => {
		if (idx < optionCount) toggle(idx);
		else if (kind === "quiz")
			setSel((prev) => ({ ...prev, selected: new Set(), otherSelected: false, dontKnow: !prev.dontKnow }));
		else {
			if (sel.otherSelected) setSel((prev) => ({ ...prev, otherSelected: false, dontKnow: false }));
			else {
				otherInputRef.current?.focus();
				selectOther();
			}
		}
	};

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
			const typing =
				!!t &&
				((t.tagName === "INPUT" && (t as HTMLInputElement).type !== "range") ||
					t.tagName === "TEXTAREA" ||
					t.isContentEditable);
			const modded = e.altKey || e.metaKey || e.ctrlKey;
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
			if (typing || modded) return;
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
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				const next = Math.max((kbdIdx ?? rowCount) - 1, 0);
				setKbdIdx(next);
				if (t?.closest?.("[data-kbdrow]")) focusRow(next);
			} else if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
				if (kind !== "quiz" || sel.dontKnow) return;
				e.preventDefault();
				setConfIdx((i) =>
					Math.min(
						CONFIDENCE_LEVELS.length - 1,
						Math.max(0, i + (e.key === "ArrowRight" ? 1 : -1)),
					),
				);
			} else if (e.key === " ") {
				if (kbdIdx === null) return;
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

	useEffect(() => {
		if (kbdIdx === null) return;
		rootRef.current
			?.querySelector(`[data-kbdrow="${kbdIdx}"]`)
			?.scrollIntoView({ block: "nearest" });
	}, [kbdIdx]);

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
										setSel((prev) => (prev.otherSelected ? prev : toggleOther(selectMode, prev)));
									}}
									onKeyDown={(e) => {
										if (e.key === "Escape") {
											e.preventDefault();
											e.stopPropagation();
											e.currentTarget.blur();
											setKbdIdx(optionCount);
										}
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
								className={cn("ftext", dictating && "dictating")}
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
									if (e.key === "Enter" && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
										e.preventDefault();
										submit();
									}
								}}
								placeholder="Why this answer? Whatever comes to mind."
								rows={phase === "teach" ? 3 : 2}
								className={cn("ftext", phase === "teach" ? "tall" : "short", dictating && "dictating")}
							/>
						)}
						<DictationMic own={isTarget} />
					</div>
					<DictationErrorLine show={isTarget} />
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
