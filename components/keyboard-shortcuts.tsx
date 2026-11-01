"use client";

import { useEffect, useRef, useState } from "react";
import { KeyChips } from "@/components/settings/keyboard-section";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useRouter } from "next/navigation";
import {
	actionForBinding,
	bindingForAction,
	eventBinding,
	formatBinding,
	isTypingSurface,
	kbdEventForAction,
	KEYBOARD_ACTIONS,
} from "@/src/core";
import { isDictationActive } from "@/components/dictation";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";

export { kbdEventForAction };

export function KeyboardShortcuts() {
	const router = useRouter();
	const [cheatOpen, setCheatOpen] = useState(false);
	const { open: openSettings } = useSettingsDialog();

	const handlersRef = useRef<{
		router: ReturnType<typeof useRouter>;
		setCheatOpen: (v: boolean) => void;
		openSettings: () => void;
	}>({ router, setCheatOpen, openSettings });
	handlersRef.current = { router, setCheatOpen, openSettings };

	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Tab") {
				e.preventDefault();
				if (e.shiftKey) window.dispatchEvent(new CustomEvent("lh:kbd-cycle-thinking"));
				// Plain Tab cycles the active surface's text fields (owner,
				// keyboard round 2026-10-06) — forward-only, wrapping; each
				// composer-bearing page answers with its own chain. The quiz
				// dock's rows↔thinking claim stops propagation at document
				// level, so a claimed Tab never reaches this dispatch.
				else if (!e.metaKey && !e.ctrlKey && !e.altKey)
					window.dispatchEvent(new CustomEvent("lh:kbd-cycle-fields"));
				return;
			}

			if (e.key === "Escape") {
				if (cheatOpen) {
					setCheatOpen(false);
					e.preventDefault();
					return;
				}
				if (isDictationActive()) {
					e.preventDefault();
					window.dispatchEvent(new CustomEvent("lh:kbd-stop-dictation"));
					return;
				}
				window.dispatchEvent(new CustomEvent("lh:kbd-abort-turn"));
				return;
			}

			const action = actionForBinding(eventBinding(e));
			if (!action) return;

			if (isTypingSurface(e) && !(e.metaKey || e.ctrlKey || e.altKey)) return;

			switch (action) {
				case "new-session":
					handlersRef.current.router.push("/");
					window.setTimeout(() => window.dispatchEvent(new CustomEvent("lh:focus-omnibar")), 150);
					break;
				case "open-settings":
					handlersRef.current.openSettings();
					break;
				case "jump-graph":
					handlersRef.current.router.push("/knowledge");
					break;
				case "cheat-sheet":
					handlersRef.current.setCheatOpen(true);
					break;
				case "find":
					// Claim Mod+F so Chromium's whole-window finder cannot open too.
					e.preventDefault();
					window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
					break;
				default:
					window.dispatchEvent(new CustomEvent(kbdEventForAction(action)));
			}
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [cheatOpen]);

	return <CheatSheet open={cheatOpen} onClose={() => setCheatOpen(false)} />;
}

function CheatSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
	const backdropDismiss = useBackdropDismiss(onClose);
	if (!open) return null;
	const scopes = ["global", "chat", "graph"] as const;
	const scopeLabels: Record<(typeof scopes)[number], string> = {
		global: "Everywhere",
		chat: "In a lesson",
		graph: "On the graph",
	};
	return (
		<div className="v4 scope">
			<div data-testid="cheat-sheet" className="overlay" {...backdropDismiss}>
				<div role="dialog" aria-modal="true" aria-label="Keyboard shortcuts" className="dialog pad cs" onClick={(e) => e.stopPropagation()}>
					<div className="dlg-head">
						<h2 className="dlg-title">Keyboard shortcuts</h2>
						<span className="cs-esc">
							<kbd className="kbd">esc</kbd> to close
						</span>
					</div>
					{scopes.map((scope) => {
						const actions = KEYBOARD_ACTIONS.filter((a) => a.scope === scope);
						if (actions.length === 0) return null;
						return (
							<div key={scope} className="cs-group">
								<span className="over">{scopeLabels[scope]}</span>
								{actions.map((a) => (
									<div key={a.id} className="cs-row">
										<span>{a.label}</span>
										<KeyChips text={formatBinding(bindingForAction(a.id))} />
									</div>
								))}
							</div>
						);
					})}
				</div>
			</div>
		</div>
	);
}
