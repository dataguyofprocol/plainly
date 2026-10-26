"use client";

import { useEffect, useRef, useState } from "react";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { Icon } from "@/components/ui/icon";

/** The unified user-thinking row: ONE visual language for every surface
 *  where the learner's own thinking renders — practice thinking traces,
 *  the reading channel lifted above the answered card, the quiz answer's
 *  thinking inside its card. It is the same quiet disclosure as the
 *  agent's "Thinking" row (icon + label + turning chevron); expanded, the
 *  text opens in a tint well in serif italics — the inner-voice
 *  signature that tells the learner's thinking from the agent's.
 *  `defaultOpen` marks transcript rows, which arrive EXPANDED (clearly
 *  conveyed that the thinking was sent); `inCard` rows sit on a card's
 *  surface and stay collapsed.
 *
 *  ⌘T (toggle-user-thinking) sets EVERY row to one state via the module
 *  store below — one source of truth, no provider tree: rows subscribe on
 *  mount; explicit sets (and only those) stomp individual toggles. */

// ── The ⌘T store (module-scope, one per page load) ─────────────────────────
// null = "rows run their own defaults" (the pre-toggle state); the first ⌘T
// resolves from `true` (transcript rows default open) and then alternates.
let allUserThinkingOpen: boolean | null = null;
const userThinkingListeners = new Set<(open: boolean) => void>();

export function currentUserThinkingOpen(): boolean {
	return allUserThinkingOpen ?? true;
}

/** The row's starting state: an explicit ⌘T set wins over the row's own
 *  default (late mounts honor the last set — same path as the live sync,
 *  readable at render time so static SSR reflects the store too). */
function resolveUserThinkingOpen(defaultOpen: boolean): boolean {
	return allUserThinkingOpen ?? defaultOpen;
}

export function setAllUserThinkingOpen(open: boolean) {
	allUserThinkingOpen = open;
	for (const l of userThinkingListeners) l(open);
}

function subscribeUserThinking(fn: (open: boolean) => void): () => void {
	userThinkingListeners.add(fn);
	if (allUserThinkingOpen !== null) fn(allUserThinkingOpen); // late mounts honor the last set
	return () => userThinkingListeners.delete(fn);
}

export function ThinkingBlock({
	label = "Your thinking",
	text,
	testId,
	dataCommit,
	defaultOpen = false,
	inCard = false,
}: {
	label?: string;
	text: string;
	testId?: string;
	/** The practice marker's register flag (commit vs nudge). */
	dataCommit?: boolean;
	/** Transcript rows arrive expanded (owner, 2026-10-07). */
	defaultOpen?: boolean;
	/** On the card's own background: no band (the accent read too light). */
	inCard?: boolean;
}) {
	const [open, setOpen] = useState(() => resolveUserThinkingOpen(defaultOpen));
	// ⌘T: an explicit global set overrides every row (once set, rows re-sync).
	const syncedRef = useRef(false);
	useEffect(
		() => subscribeUserThinking((o) => { syncedRef.current = true; setOpen(o); }),
		[],
	);
	return (
		<div
			data-testid={testId}
			data-commit={dataCommit === undefined ? undefined : dataCommit ? "true" : "false"}
			className={inCard ? "ls-think ls-uthink in-card" : "ls-think ls-uthink lh-card-enter"}
		>
			<button
				type="button"
				data-testid={testId ? `${testId}-trigger` : undefined}
				onClick={(e) => {
					setOpen((v) => !v);
					blurAfterPointerClick(e);
				}}
				aria-expanded={open}
				className="ls-think-t"
			>
				<Icon name="edit" size="sm" />
				{label}
				<Icon name="chevron-right" size="xs" className="ls-chev" />
			</button>
			{open && <div className="ls-well mine">{text}</div>}
		</div>
	);
}
