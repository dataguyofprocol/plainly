"use client";

import { useState } from "react";
import { CONFIDENCE_LEVEL_COLORS, nearestLevel } from "@/components/confidence-colors";
import { Icon } from "@/components/ui/icon";
import { ThinkingBlock } from "@/components/thinking-block";
import { cn } from "@/lib/utils";
import { MessageResponse } from "@/components/ai-elements/message";
import type { QuestionAnswerData } from "@/src/core";
import { decodeOverescapedNewlines, parseAskInput, parseQuizInput } from "@/src/core";

export function AnsweredCard({ answer, input }: { answer: QuestionAnswerData; input?: unknown }) {
	const [whyOpen, setWhyOpen] = useState(false);
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
	const askInput = answer.kind === "ask" ? parseAskInput(input) : undefined;
	const parsedDetails = askInput?.details ?? (answer.kind === "quiz" ? parseQuizInput(input)?.details : undefined);
	const descByIndex = new Map((askInput?.options ?? []).map((o, i) => [i + 1, o.description]));

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
	const why = isQuiz && answer.explanation ? decodeOverescapedNewlines(answer.explanation) : null;

	return (
		<>
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
										<MessageResponse className="ls-opt-desc">{descByIndex.get(opt.index)}</MessageResponse>
									)}
								</span>
								{sel && <span className="ls-opt-you">Your answer</span>}
							</li>
						);
					})}
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

			{isExplain && answer.committed && (
				<div className="ls-reveal lh-answered-ui">
					<b>The answer: </b>
					<MessageResponse className="inline [&_p]:inline [&_p]:m-0">{answer.committed}</MessageResponse>
				</div>
			)}

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
						<ThinkingBlock testId="your-thinking" label="Your thinking" text={thinking} inCard />
					)}
					{why && (
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
