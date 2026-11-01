"use client";

import { useEffect, useRef, useState } from "react";
import { blurAfterPointerClick } from "@/components/focus-hygiene";
import { Icon } from "@/components/ui/icon";

let allUserThinkingOpen: boolean | null = null;
const userThinkingListeners = new Set<(open: boolean) => void>();

export function currentUserThinkingOpen(): boolean {
	return allUserThinkingOpen ?? true;
}

function resolveUserThinkingOpen(defaultOpen: boolean): boolean {
	return allUserThinkingOpen ?? defaultOpen;
}

export function setAllUserThinkingOpen(open: boolean) {
	allUserThinkingOpen = open;
	for (const l of userThinkingListeners) l(open);
}

function subscribeUserThinking(fn: (open: boolean) => void): () => void {
	userThinkingListeners.add(fn);
	if (allUserThinkingOpen !== null) fn(allUserThinkingOpen);
	return () => userThinkingListeners.delete(fn);
}

export function ThinkingBlock({
	label = "Your thinking",
	tag,
	text,
	testId,
	dataCommit,
	defaultOpen = false,
	inCard = false,
}: {
	label?: string;
	tag?: string;
	text: string;
	testId?: string;
	dataCommit?: boolean;
	defaultOpen?: boolean;
	inCard?: boolean;
}) {
	const [open, setOpen] = useState(() => resolveUserThinkingOpen(defaultOpen));
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
				{tag && <span className="pill practice">{tag}</span>}
				<Icon name="chevron-right" size="xs" className="ls-chev" />
			</button>
			{open && <div className="ls-well mine">{text}</div>}
		</div>
	);
}
