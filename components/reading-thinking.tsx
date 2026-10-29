"use client";

import { useCallback, useRef } from "react";
import { DictationErrorLine, DictationMic, joinDictation, useDictationState, useDictationTarget } from "@/components/dictation";
import { cn } from "@/lib/utils";

/**
 * The reading-thinking field (owner design 2026-10-03, "two questions per
 * teaching unit"): a quiet textarea for thinking WHILE READING the
 * teaching prose — the same transfer channel the question dock's "Your
 * thinking" gives the answer, opened one phase earlier. It mounts while a
 * teach-phase check waits behind its reveal (the same cue that collapses
 * the check), rides the check answer as the SEPARATE `readingThinking`
 * channel (never conflated with the quiz thinking), and disappears with
 * the question.
 *
 * Dictation: while the check sits UNREVEALED this field is the primary
 * target (the dock releases its claim — dictated reading-thoughts land
 * here, not in the hidden quiz field); once the learner reveals the
 * check, the dock reclaims and this field is plain typing.
 */
export function ReadingThinkingField({
	value,
	onChange,
	onEscape,
	onOpen,
	claim,
}: {
	value: string;
	onChange: (v: string) => void;
	/** Esc in the field stops dictation, keeping the text (threaded from the page's hook). */
	onEscape?: () => void;
	/** The check waits CLOSED — Enter opens it (owner, keyboard round
	 *  2026-10-06). The caller finishes any live dictation FIRST (the
	 *  flush lands here — the field is the live claim), then reveals.
	 *  Absent = the check is open: Enter keeps the dumping convention. */
	onOpen?: () => void;
	/** Primary dictation claim — true while the check is behind its reveal. */
	claim: boolean;
}) {
	/* Ref-first (live finals, owner round 4): two finals can land before
	 * the parent re-renders, so the join reads the mirror, not `value`. */
	const valueRef = useRef(value);
	valueRef.current = value;
	const isTarget = useDictationTarget(
		useCallback(
			(t: string) => {
				const v = joinDictation(valueRef.current, t);
				valueRef.current = v;
				onChange(v);
			},
			[onChange],
		),
		claim,
	);
	const dictationPhase = useDictationState().phase;
	const dictating = isTarget && dictationPhase !== "idle";
	return (
		<div data-testid="reading-thinking-field" className="rthink">
			<label className="flabel" htmlFor="reading-thinking">
				Thinking while reading
			</label>
			<div className="fwrap">
				<textarea
					id="reading-thinking"
					value={value}
					onChange={(e) => onChange(e.target.value)}
					/* The field grows with its content (field-sizing) up to 160px
					   (max-h-40), then scrolls. Its vertical padding is load-bearing:
					   a zero-padding field-sizing textarea turns the font box's 1px
					   overhang into a permanent 1px scrollbar (owner round,
					   2026-10-07); .ftext's 10px absorbs it. */
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							// Esc stops dictation (the strip's rule) — claimed so the
							// window chain doesn't also read it as abort-turn.
							e.preventDefault();
							e.stopPropagation();
							onEscape?.();
							return;
						}
						// ENTER OPENS THE WAITING CHECK (owner, keyboard round
						// 2026-10-06): while the check sits closed, plain Enter
						// (and the universal ⌘/Ctrl+Enter) opens it — the dictation
						// flush lands HERE first via the caller's finishDictation,
						// so spoken thoughts ride along. Shift+Enter stays a newline.
						if (e.key === "Enter" && onOpen !== undefined && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							e.stopPropagation();
							onOpen();
							return;
						}
						// The dock's dumping convention: plain Enter is a newline.
						// No submit button here — the check's own submit is this
						// field's carrier — so ⌘↵ just blurs.
						if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							e.currentTarget.blur();
						}
					}}
					placeholder="Whatever comes to mind as you read."
					rows={1}
					className={cn("ftext rthink-in field-sizing-content max-h-40", dictating && "dictating")}
				/>
				<DictationMic own={isTarget} />
			</div>
			<DictationErrorLine show={isTarget} />
			<span className="fhint">Sent along with your answer to the check.</span>
		</div>
	);
}
