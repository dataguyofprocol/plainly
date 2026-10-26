"use client";

import { useState } from "react";
import { CONFIDENCE_LEVEL_COLORS, nearestLevel } from "@/components/confidence-colors";
import { Icon } from "@/components/ui/icon";
import { ThinkingBlock } from "@/components/thinking-block";
import { cn } from "@/lib/utils";
import { MessageResponse } from "@/components/ai-elements/message";
import type { QuestionAnswerData } from "@/src/core";
import { parseAskInput, parseQuizInput } from "@/src/core";

/**
 * Static rendering of an answered question (tool part in `output-available`).
 *
 * Quiz answers are GRADED: check/cross marks, the correct answers, and
 * the explanation (tucked behind "Why"). Ask answers are NOT graded — a plain record of what was said.
 * (The v1 bug this pins: ask answers must never get quiz grading UI.)
 * Explain answers are graded by the MODEL in its next reply, not by the
 * client — the card reveals his answer, the committed correct answer, and
 * the explanation, with NO verdict chips (owner ruling 2026-09-27).
 */
export function AnsweredCard({ answer, input }: { answer: QuestionAnswerData; input?: unknown }) {
	const [whyOpen, setWhyOpen] = useState(false); // the tucked explanation (predictions, owner 2026-10-03)
	if (answer.dismissed) {
		return (
			<div className="ls-skip" data-outcome="skipped">
				<Icon name="status-paused" size="sm" />
				<span className="ls-skip-q">{answer.questionText}</span>
				<span className="pill muted">Skipped</span>
			</div>
		);
	}

	const isQuiz = answer.kind === "quiz";
	const isExplain = answer.kind === "explain";
	const selectedIdx = new Set(answer.answers.map((a) => a.index));
	const correctIdx = new Set(answer.correctIndices ?? []);
	// The question's own context rides the ORIGINAL CALL, not the answer
	// snapshot (owner, 2026-10-12): the details line — and, for ask
	// questions, option descriptions — re-render from the persisted
	// arguments, so every existing transcript shows them too. The lean
	// snapshot (what the model sees, compactAnswerForModel) is untouched;
	// any parse failure or absent input renders exactly the older card.
	const askInput = answer.kind === "ask" ? parseAskInput(input) : undefined;
	const parsedDetails = askInput?.details ?? (answer.kind === "quiz" ? parseQuizInput(input)?.details : undefined);
	const descByIndex = new Map((askInput?.options ?? []).map((o, i) => [i + 1, o.description]));

	// The tool's OWN name first (owner 2026-10-09): probe-phase cards label
	// Probe/Recall — the phase boundary visible in the transcript. No
	// `tool` on old records: kind labels as before.
	const kindLabel =
		answer.tool === "probe"
			? "Probe"
			: answer.tool === "recall"
				? "Recall"
				: isQuiz
					? answer.questionType === "predict"
						? "Prediction"
						: "Check"
					: isExplain
						? "Explain"
						: "Question";
	const outcome = !isQuiz ? undefined : answer.dontKnow ? "dontKnow" : answer.correct ? "correct" : "incorrect";
	const thinking = answer.thinking ?? answer.note;
	const why = isQuiz && answer.explanation ? answer.explanation : null;

	return (
		<>
		{/* The reading channel LIFTED (owner round, 2026-10-05): thoughts
		    captured while reading are chronologically PRIOR to the question —
		    their own row ABOVE the card, arriving expanded. */}
		{answer.readingThinking && (
			<ThinkingBlock testId="reading-thinking-block" label="Your thinking" text={answer.readingThinking} defaultOpen />
		)}
		<div className="lh-answered ls-card" data-testid="answered-card" data-outcome={outcome}>
			<div className="ls-ans-h">
				<span className="over">{kindLabel}</span>
				{outcome === "dontKnow" ? (
					<span className="pill muted">Didn’t know</span>
				) : outcome === "correct" ? (
					<span className="pill good">Correct</span>
				) : outcome === "incorrect" ? (
					<span className="pill danger">Incorrect</span>
				) : null}
			</div>
			<div className="ls-ans-q">
				<MessageResponse>{answer.questionText}</MessageResponse>
			</div>
			{parsedDetails && (
				// The details line, same paint as the pending dock (owner,
				// 2026-10-12): full markdown, LaTeX included.
				<div className="ls-ans-d">
					<MessageResponse>{parsedDetails}</MessageResponse>
				</div>
			)}

			{((answer.options?.length ?? 0) > 0 || answer.other) && (
				<ul className="ls-opts lh-answered-ui">
					{answer.options?.map((opt) => {
						const sel = selectedIdx.has(opt.index);
						const key = isQuiz && correctIdx.has(opt.index);
						const wrong = isQuiz && sel && !key;
						return (
							<li key={opt.index} className={cn("ls-opt", key && "key", sel && "sel", wrong && "wrong", sel && !isQuiz && "pick")}>
								<span
									className="ls-opt-mark"
									aria-hidden
									data-mark={isQuiz ? (key ? "check" : wrong ? "x" : undefined) : undefined}
								>
									{key || (sel && !isQuiz) ? (
										<Icon name="check" size="sm" />
									) : wrong ? (
										<Icon name="close" size="sm" />
									) : (
										<span className="ls-ring" />
									)}
								</span>
								<span className="ls-opt-body">
									<MessageResponse>{opt.label}</MessageResponse>
									{sel && descByIndex.get(opt.index) && (
										// Ask-option subtext (owner, 2026-10-12): same markdown path
										// as the pending dock — LaTeX included. Quiz options carry
										// none (owner ruling 2026-09-26); the map stays empty for them.
										<MessageResponse className="ls-opt-desc">{descByIndex.get(opt.index)}</MessageResponse>
									)}
								</span>
								{sel && <span className="ls-opt-you">Your answer</span>}
							</li>
						);
					})}
					{/* The learner's own typed option is an OPTION — same list,
					    same selected styling as its siblings. */}
					{answer.other && (
						<li data-testid="answered-other" className="ls-opt sel pick">
							<span className="ls-opt-mark" aria-hidden>
								<Icon name="check" size="sm" />
							</span>
							<span className="ls-opt-body">“{answer.other}”</span>
							<span className="ls-opt-you">Your answer</span>
						</li>
					)}
				</ul>
			)}

			{answer.text && (
				<div className="ls-mine">
					<span className="over">Your answer</span>
					<p>{answer.text}</p>
				</div>
			)}

			{/* The explain reveal (owner ruling 2026-09-27): the committed answer
			    — one field, reasoning included — shown on submit; no verdict,
			    the model's next reply IS the grading. */}
			{isExplain && answer.committed && (
				<div className="ls-reveal lh-answered-ui">
					<b>The answer: </b>
					<MessageResponse className="inline [&_p]:inline [&_p]:m-0">{answer.committed}</MessageResponse>
				</div>
			)}

			{/* The confidence record: the level word in its colour (the live
			    switch's palette); old six-stop answers read as their nearest
			    level, the number kept in the title. Quiz answers only, and only
			    when a confidence exists. */}
			{isQuiz && answer.confidence != null && (() => {
				const level = nearestLevel(answer.confidence);
				const c = CONFIDENCE_LEVEL_COLORS[level.value]!;
				return (
					<div className="ls-ans-meta">
						<span data-testid="answered-confidence" title={`${answer.confidence}%`}>
							How sure
							<span className="ls-conf" style={{ background: c.soft, color: c.ink }}>
								{level.label}
							</span>
						</span>
					</div>
				);
			})()}

			{(thinking || why) && (
				<div className="ls-ans-foot">
					{thinking && (
						/* The SAME unified row as every user-thinking surface; in a
						   card it arrives collapsed. */
						<ThinkingBlock testId="your-thinking" label="Your thinking" text={thinking} inCard />
					)}
					{why && (
						/* The TUCKED explanation — ALL questions (owner, 2026-10-07):
						   the verdict shows, the explanation sits behind Why. */
						<div className="ls-think" data-testid="tucked-explanation">
							<button type="button" className="ls-think-t" aria-expanded={whyOpen} onClick={() => setWhyOpen((v) => !v)}>
								<Icon name="idea" size="sm" />
								Why
								<Icon name="chevron-right" size="xs" className="ls-chev" />
							</button>
							{whyOpen && (
								<div className="ls-well lh-answered-ui">
									<MessageResponse>{why}</MessageResponse>
								</div>
							)}
						</div>
					)}
				</div>
			)}
		</div>
		</>
	);
}
