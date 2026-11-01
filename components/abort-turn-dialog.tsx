"use client";

import { useEffect } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { Icon, type IconName } from "@/components/ui/icon";

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

export function AbortTurnBody({
	mode,
	onClose,
	onConfirm,
	busy = false,
}: {
	mode: AbortMode;
	onClose: () => void;
	onConfirm: () => void;
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
	mode: AbortMode | null;
	onClose: () => void;
	onConfirm: (mode: AbortMode) => void;
	busy?: boolean;
}) {
	useEffect(() => {
		if (mode === null) return;
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				// Document level: a window-level stopPropagation cannot stop the
				// earlier-registered global window listener.
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
