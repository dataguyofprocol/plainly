"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { Icon, type IconName } from "@/components/ui/icon";

/**
 * The ESC-abort guard (owner, 2026-10-02): the global Esc → abort chain
 * opens this confirm popup EVERYWHERE — mid-stream aborts and pending-
 * question dismissals alike. Esc on the popup itself cancels (claimed —
 * it must never chain into another abort), which is also why Chat's
 * abort handler ignores events while this dialog is open: two window
 * listeners fire per Esc and stopPropagation alone cannot order them.
 *
 * MINIMAL, the delete-node dialog's tone: title, one line, Cancel +
 * action. No busy state — both actions are local (a fetch that fires
 * and forgets, an answer submit whose own machinery shows progress).
 *
 * What "abort" means is mode-dependent: from a running turn it kills
 * the turn (partial stays); from a pending question there is no turn to
 * kill — abort IS dismissal (A2, 2026-10-03): the silent route writes
 * the skipped toolResult and wakes NOTHING; the session pauses until
 * the user's next plain message, which carries the dismissal to the
 * model in its context.
 */

/** What Esc is aborting — drives copy and the confirm action. */
export type AbortMode = "turn" | "question" | "problem";

const ICON: Record<AbortMode, IconName> = { turn: "stop", question: "ask", problem: "practice" };

const COPY: Record<AbortMode, { title: string; line: string; action: string }> = {
	turn: {
		title: "Abort this turn?",
		line: "The partial answer stays in the transcript.",
		action: "Abort",
	},
	question: {
		title: "Dismiss this question?",
		line: "Skipped — the teacher moves on without it.",
		action: "Dismiss",
	},
	problem: {
		title: "Discard this problem?",
		line: "The problem is dropped — no solution is revealed.",
		action: "Discard",
	},
};

/** The dialog's pure body — exported for SSR pins (the delete-node
 * pattern). The wrapper owns effects + the portal. */
export function AbortTurnBody({
	mode,
	onClose,
	onConfirm,
	busy = false,
}: {
	mode: AbortMode;
	onClose: () => void;
	onConfirm: () => void;
	/** The dismiss doubles as the abort when a turn is still running
	 * (owner, 2026-10-04): the line says so. */
	busy?: boolean;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);
	const copy = COPY[mode];
	return (
		<div className="v4 scope">
			<div
				role="dialog"
				aria-modal="true"
				aria-label={copy.title}
				data-testid="abort-turn-dialog"
				className="overlay"
				// A genuine click on the scrim cancels — the cautious default, like Esc.
				{...backdropDismiss}
			>
				<div className="dialog pad cd sm" onClick={(e) => e.stopPropagation()}>
					<div className="dlg-head">
						<span className="well danger" aria-hidden>
							<Icon name={ICON[mode]} size="lg" />
						</span>
						<div>
							<h2 className="dlg-title" data-testid="abort-turn-title">
								{copy.title}
							</h2>
							<p className="dlg-body" data-testid="abort-turn-line">
								{copy.line}
								{busy && mode !== "turn" ? " The working turn stops too." : ""}
							</p>
						</div>
					</div>
					<div className="dlg-actions">
						<button type="button" data-testid="abort-turn-cancel" onClick={onClose} className="btn secondary">
							Cancel
						</button>
						<button
							type="button"
							data-testid="abort-turn-confirm"
							// The destructive pair (render pin: the confirm is the destructive one).
							data-tone="destructive"
							onClick={onConfirm}
							className="btn danger"
						>
							{copy.action}
						</button>
					</div>
				</div>
			</div>
		</div>
	);
}

export function AbortTurnDialog({
	mode,
	onClose,
	onConfirm,
	busy = false,
}: {
	/** What Esc is aborting; null = closed (nothing rendered). */
	mode: AbortMode | null;
	onClose: () => void;
	onConfirm: (mode: AbortMode) => void;
	busy?: boolean;
}) {
	// Esc cancels the popup (claimed — never a chained abort).
	useEffect(() => {
		if (mode === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// THE ONE-ESC LAW (keyboard round 2026-10-06): claim at the
				// document level — a window-level stopPropagation cannot stop
				// the earlier-registered global window listener.
				e.preventDefault();
				e.stopPropagation();
				onClose();
			}
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [mode, onClose]);

	if (mode === null || typeof document === "undefined") return null;
	return createPortal(
		<AbortTurnBody mode={mode} onClose={onClose} onConfirm={() => onConfirm(mode)} busy={busy} />,
		document.body,
	);
}
