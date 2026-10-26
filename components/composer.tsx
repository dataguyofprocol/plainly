"use client";

import { ArrowRightIcon, SquareIcon } from "lucide-react";

/**
 * The session composer — Lesson4's steer row (see the render below).
 */
/** What one Enter press does, in precedence order: stop a busy stream,
 *  otherwise send the message, otherwise — practice sessions only — fire
 *  the next-problem signal while the between-problems pause is live
 *  (owner round 16: Enter on an EMPTY composer is the go-ahead; typing
 *  anything makes Enter a send again). Pure so the static-render harness
 *  can pin the decision (key events can't be simulated in
 *  renderToStaticMarkup). */
export function enterAction(state: {
	busy: boolean;
	canSend: boolean;
	/** The between-problems pause is live: practice session, nothing
	 *  active, no turn/compaction in flight (the caller's fold). */
	nextProblem?: boolean;
}): "stop" | "send" | "next" | "none" {
	// Composer steering (owner arc 2026-10-03): while a turn runs, typed
	// text makes Enter a STEER (the queue-and-redirect send); Enter with
	// an empty composer stays the stop shortcut. The button itself keeps
	// the square — Stop stays one click away at all times.
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
	placeholder = "Ask, answer, or steer the lesson…",
	nextProblem = false,
	onNext,
	trailing,
}: {
	busy: boolean;
	value: string;
	onChange: (v: string) => void;
	onSend: () => void;
	onStop: () => void;
	canSend: boolean;
	autoFocus?: boolean;
	/** The page's handle to the textarea — the dictation-end focus (owner,
	 *  2026-10-01): a run ending hands the cursor to the bare composer. */
	inputRef?: React.RefObject<HTMLTextAreaElement | null>;
	/** Escape while a dictation runs stops it (STT wave, 2026-09-17). No-op
	 *  when absent — Esc otherwise means nothing in the composer. */
	onEscape?: () => void;
	/** The textarea's placeholder (owner refinement round, 2026-09-24):
	 *  active sessions read "Ask, answer, or steer the lesson…"; the fresh
	 *  new-session page asks the graph view's opening question instead. */
	placeholder?: string;
	/** The practice pause is live (owner round 16): Enter on the empty
	 *  composer fires the next-problem signal instead of doing nothing —
	 *  the keyboard-first move-on. */
	nextProblem?: boolean;
	/** The signal's dispatcher (send({type:"next"})) — the chip and the
	 *  empty-Enter share it. */
	onNext?: () => void;
	/** A control at the row's end, before the button (the session's mic). */
	trailing?: React.ReactNode;
}) {
	const act = () => {
		const action = enterAction({ busy, canSend, nextProblem });
		if (action === "stop") onStop();
		else if (action === "send") onSend();
		else if (action === "next") onNext?.();
	};
	// Lesson4's steer row (v4 rebuild, 2026-10-26): one glass row — the
	// field, a quiet line saying what Enter will do, and a text button. The
	// behaviour is unchanged: send, steer mid-turn ("Queue" — answered after
	// this step), stop on an empty field mid-turn, next problem in the pause.
	const action = enterAction({ busy, canSend, nextProblem });
	const hint = busy && canSend ? "answered after this step" : busy ? "↵ stops the reply" : null;
	return (
		<form
			data-testid="composer"
			className="glass"
			style={{ display: "flex", alignItems: "flex-end", gap: 6, padding: "4px 4px 4px 14px", borderRadius: 12 }}
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
					// Esc ends dictation before anything else Esc might someday mean
					// here; stopPropagation claims it (keyboard wave A) so the
					// window-level chain doesn't also abort a turn.
					if (e.key === "Escape" && onEscape) {
						e.preventDefault();
						e.stopPropagation();
						onEscape();
						return;
					}
					// Enter sends, Shift+Enter is a newline; ⌘/Ctrl+Enter also sends.
					if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !e.shiftKey)) {
						e.preventDefault();
						act();
					}
				}}
				placeholder={placeholder}
				autoFocus={autoFocus}
				rows={1}
				aria-label="Ask about this step, or steer the lesson"
				className="field-sizing-content"
				style={{ flex: 1, minWidth: 0, minHeight: 36, maxHeight: 192, padding: "8px 0", border: 0, background: "transparent", outline: "none", resize: "none", fontSize: 13.5, lineHeight: "20px" }}
			/>
			{hint && (
				<span className="hide-sm" style={{ alignSelf: "center", fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap" }}>
					{hint}
				</span>
			)}
			{trailing}
			{nextProblem && !busy && !canSend ? (
				<button type="submit" data-testid="next-problem-button" aria-label="Next problem" className="btn" style={{ height: 30, padding: "0 12px", background: "var(--good)" }}>
					Next problem <ArrowRightIcon className="size-3.5" />
				</button>
			) : action === "stop" ? (
				<button type="submit" aria-label="Stop" className="ghost" style={{ height: 30 }}>
					<SquareIcon className="size-3" /> Stop
				</button>
			) : (
				<button type="submit" aria-label="Send" disabled={!busy && !canSend} className="btn" style={{ height: 30, padding: "0 12px" }}>
					{busy ? "Queue" : "Send"}
				</button>
			)}
		</form>
	);
}
