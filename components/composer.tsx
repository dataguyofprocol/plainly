"use client";

import { Icon } from "@/components/ui/icon";
import { Hint } from "@/components/ui/hint";
import { useFileDrop } from "@/components/attachments";

export function enterAction(state: {
	busy: boolean;
	canSend: boolean;
	nextProblem?: boolean;
}): "stop" | "send" | "next" | "none" {
	if (state.busy) return state.canSend ? "send" : "stop";
	if (state.canSend) return "send";
	if (state.nextProblem) return "next";
	return "none";
}

export function Composer({
	busy,
	value,
	onChange,
	onSend,
	onStop,
	canSend,
	autoFocus,
	inputRef,
	onEscape,
	dictating = false,
	placeholder = "Ask, answer, or steer the lesson…",
	nextProblem = false,
	onNext,
	trailing,
	onFiles,
}: {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	autoFocus?: boolean;
	inputRef?: React.RefObject<HTMLTextAreaElement | null>;
	onEscape?: () => void;
	dictating?: boolean;
	placeholder?: string;
	nextProblem?: boolean;
	onNext?: () => void;
	trailing?: React.ReactNode;
	onFiles?: (files: File[]) => void;
}) {
	const drop = useFileDrop(onFiles);
	const act = () => {
		const action = enterAction({ busy, canSend, nextProblem });
		if (action === "stop") onStop();
		else if (action === "send") onSend();
		else if (action === "next") onNext?.();
	};
	const action = enterAction({ busy, canSend, nextProblem });
	const hint = busy && canSend ? "Answered after this step" : busy ? "stops the reply" : null;
	return (
		<form
			data-testid="composer"
			className={`ls-composer${dictating ? " dictating" : ""}${drop.dropping ? " dropping" : ""}`}
			{...drop.handlers}
			onSubmit={(e) => {
				e.preventDefault();
				act();
			}}
		>
			<textarea
				ref={inputRef}
				value={value}
				onChange={(e) => onChange(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Escape" && onEscape) {
						e.preventDefault();
						e.stopPropagation();
						onEscape();
						return;
					}
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
						e.preventDefault();
						act();
					}
				}}
				placeholder={placeholder}
				autoFocus={autoFocus}
				rows={1}
				aria-label="Ask about this step, or steer the lesson"
			/>
			{hint && (
				<span className="ls-hint hide-sm">
					{action === "stop" && <span className="kbd">↵</span>}
					{hint}
				</span>
			)}
			{trailing}
			{nextProblem && !busy && !canSend ? (
				<button type="submit" data-testid="next-problem-button" aria-label="Next problem" className="btn brand ls-next">
					Next problem <Icon name="arrow-right" size="sm" />
				</button>
			) : action === "stop" ? (
				<Hint label="Stop the reply" side="top">
					<button type="submit" aria-label="Stop" className="ls-send stop">
						<Icon name="stop" size="sm" />
					</button>
				</Hint>
			) : (
				<Hint label={busy ? "Queue for after this step" : "Send"} binding="enter" side="top">
					<button type="submit" aria-label="Send" disabled={!busy && !canSend} className="ls-send">
						<Icon name="send" size="md" />
					</button>
				</Hint>
			)}
		</form>
	);
}
