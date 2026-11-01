"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import type { ChatDeleteMode, ChatListItem } from "@/src/core";
import { Icon } from "@/components/ui/icon";
import { displayTitle } from "@/components/ui/format";

export const TRACES_COPY = {
	testid: "delete-traces",
	checkbox: "delete-traces-checkbox",
	title: "Also remove its graph traces",
	body: "This session’s topics, links, and events leave the graph too. Topics other sessions or imported notes also cover survive; topics only this session created are removed entirely.",
};

export function DeleteSessionDialog({
	chat,
	onClose,
	onDeleted,
}: {
	chat: Pick<ChatListItem, "id" | "title"> | null;
	onClose: () => void;
	onDeleted: (id: string, mode: ChatDeleteMode, graphRevision: number) => void;
}) {
	const [traces, setTraces] = useState(false);
	const [busy, setBusy] = useState(false);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	const [failure, setFailure] = useState<{ code: string; error: string } | null>(null);

	useEffect(() => {
		if (!chat) {
			setTraces(false);
			setBusy(false);
			setFailure(null);
		}
	}, [chat]);

	useEffect(() => {
		if (!chat) return;
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
	}, [chat, onClose]);

	const run = async () => {
		if (!chat || busy) return;
		const mode: ChatDeleteMode = traces ? "delete-nodes" : "preserve-graph";
		setBusy(true);
		setFailure(null);
		try {
			const res = await fetch(`/api/chats/${chat.id}?mode=${mode}`, { method: "DELETE" });
			const body = (await res.json()) as {
				ok?: boolean;
				error?: string;
				code?: string;
				graphRevision?: number;
			};
			if (!res.ok) {
				setFailure({ code: body.code ?? "error", error: body.error ?? `Delete failed (${res.status})` });
				setBusy(false);
				return;
			}
			onDeleted(chat.id, mode, body.graphRevision ?? 0);
		} catch {
			setFailure({ code: "network", error: "Delete failed — network error. Try again." });
			setBusy(false);
		}
	};

	if (!chat) return null;

	return createPortal(
		<div className="v4 scope">
		<div className="overlay" {...backdropDismiss}>
			<DeleteSessionBody
				chat={chat}
				traces={traces}
				busy={busy}
				failure={failure}
				onTraces={(next) => setTraces(next)}
				onClose={onClose}
				onRun={() => void run()}
			/>
		</div>
		</div>,
		document.body,
	);
}

export function DeleteSessionBody({
	chat,
	traces,
	busy,
	failure,
	onTraces,
	onClose,
	onRun,
}: {
	chat: Pick<ChatListItem, "id" | "title">;
	traces: boolean;
	busy: boolean;
	failure: { code: string; error: string } | null;
	onTraces: (next: boolean) => void;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete session"
			data-testid="delete-session-dialog"
			onClick={(e) => e.stopPropagation()}
			className="dialog pad cd"
		>
			<div className="dlg-head">
				<span className="well danger" aria-hidden>
					<Icon name="delete" size="lg" />
				</span>
				<div>
					<h2 className="dlg-title">Delete session?</h2>
					<p data-testid="session-name-code" className="cd-name">
						{displayTitle(chat.title)}
					</p>
				</div>
			</div>
			<p className="dlg-body">
				This removes the session for good: its messages, background work, and extraction records. What it added to
				your graph stays unless you choose below.
			</p>
			<label data-testid={TRACES_COPY.testid} className="inset row">
				<input
					type="checkbox"
					data-testid={TRACES_COPY.checkbox}
					checked={traces}
					onChange={(e) => onTraces(e.target.checked)}
					disabled={busy}
				/>
				<span className="min-w-0">
					<span className="inset-t">{TRACES_COPY.title}</span>
					<span className="inset-d">{TRACES_COPY.body}</span>
				</span>
			</label>
			{failure && (
				<div role="alert" data-testid="delete-failure" className="inset cd-fail">
					<Icon name="status-warn" size="sm" />
					<span>{failure.error}</span>
					<button type="button" data-testid="delete-retry" onClick={onRun} disabled={busy} className="link">
						Try again
					</button>
				</div>
			)}
			<div className="dlg-actions">
				<button type="button" data-testid="delete-cancel" onClick={onClose} disabled={busy} className="btn secondary">
					Cancel
				</button>
				<button type="button" data-testid="delete-confirm" onClick={onRun} disabled={busy} className="btn danger">
					{busy ? "Deleting…" : "Delete session"}
				</button>
			</div>
		</div>
	);
}
