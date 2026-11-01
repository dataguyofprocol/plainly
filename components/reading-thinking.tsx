"use client";

import { useCallback, useRef } from "react";
import { DictationErrorLine, DictationMic, joinDictation, useDictationState, useDictationTarget } from "@/components/dictation";
import { cn } from "@/lib/utils";

export function ReadingThinkingField({
	value,
	onChange,
	onEscape,
	onOpen,
	claim,
}: {
	value: string;
	onChange: (v: string) => void;
	onEscape?: () => void;
	onOpen?: () => void;
	claim: boolean;
}) {
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
							e.preventDefault();
							e.stopPropagation();
							onEscape?.();
							return;
						}
						if (e.key === "Enter" && onOpen !== undefined && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
							e.preventDefault();
							e.stopPropagation();
							onOpen();
							return;
						}
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
