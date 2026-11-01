"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { Icon } from "@/components/ui/icon";

export const EXTRACTION_RETRY_LINE = "An extraction is running — try again in a moment.";

export function DeleteNodeBody({
	nodes,
	busy,
	failure,
	onClose,
	onRun,
}: {
	nodes: { id: string; name: string }[];
	busy: boolean;
	failure: { code: string; error: string } | null;
	onClose: () => void;
	onRun: () => void;
}) {
	return (
		<div
			role="dialog"
			aria-modal="true"
			aria-label="Delete idea"
			data-testid="delete-node-dialog"
			onClick={(e) => e.stopPropagation()}
			className="dialog kdlg"
		>
			<div className="kdlg-head">
				<span className="kdlg-ic" aria-hidden="true">
					<Icon name="delete" size="md" />
				</span>
				<div className="kdlg-t">
					<h2>{nodes.length === 1 ? "Delete idea?" : `Delete ${nodes.length} ideas?`}</h2>
					{nodes.length === 1 ? (
						<code data-testid="node-name-code" className="kdlg-names">
							{nodes[0]?.name}
						</code>
					) : (
						<code data-testid="node-names-code" className="kdlg-names">
							{nodes.slice(0, 8).map((n) => n.name).join(", ")}
							{nodes.length > 8 ? `, and ${nodes.length - 8} more` : ""}
						</code>
					)}
				</div>
			</div>
			<p className="kdlg-line" data-testid="node-permanence-line">
				{nodes.length === 1
					? "This permanently deletes the idea — this cannot be undone."
					: `This permanently deletes all ${nodes.length} ideas — this cannot be undone.`}
			</p>
			{failure && (
				<div role="alert" data-testid="node-delete-failure" className="kdlg-fail">
					<Icon name="status-error" size="sm" />
					<span>{failure.code === "extraction_running" ? EXTRACTION_RETRY_LINE : failure.error}</span>
					<button type="button" data-testid="node-delete-retry" onClick={onRun} disabled={busy} className="link">
						Try again
					</button>
				</div>
			)}
			<div className="kdlg-actions">
				<button type="button" data-testid="node-delete-cancel" onClick={onClose} disabled={busy} className="btn quiet">
					Cancel
				</button>
				<button type="button" data-testid="node-delete-confirm" onClick={onRun} disabled={busy} className="btn danger">
					{busy ? "Deleting…" : "Delete"}
				</button>
			</div>
		</div>
	);
}

export function DeleteNodeDialog({
	nodes,
	onClose,
	onDeleted,
}: {
	nodes: { id: string; name: string }[] | null;
	onClose: () => void;
	onDeleted: (nodeIds: string[], graphRevision: number) => void;
}) {
	const [busy, setBusy] = useState(false);
	const backdropDismiss = useBackdropDismiss(() => {
		if (!busy) onClose();
	});
	const [failure, setFailure] = useState<{ code: string; error: string } | null>(null);

	useEffect(() => {
		if (!nodes || nodes.length === 0) {
			setBusy(false);
			setFailure(null);
		}
	}, [nodes]);

	useEffect(() => {
		if (!nodes || nodes.length === 0) return;
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
	}, [nodes, onClose]);

	const run = async () => {
		if (!nodes || nodes.length === 0 || busy) return;
		setBusy(true);
		setFailure(null);
		const dead: string[] = [];
		let revision = 0;
		try {
			for (const n of nodes) {
				const res = await fetch(`/api/graph/nodes/${encodeURIComponent(n.id)}`, { method: "DELETE" });
				const body = (await res.json()) as {
					error?: string;
					code?: string;
					graphRevision?: number;
				};
				if (!res.ok) {
					setFailure({ code: body.code ?? "error", error: body.error ?? `Delete failed (${res.status})` });
					setBusy(false);
					if (dead.length > 0) onDeleted(dead, revision);
					return;
				}
				dead.push(n.id);
				revision = body.graphRevision ?? revision;
			}
			onDeleted(dead, revision);
		} catch {
			setFailure({ code: "network", error: "Delete failed — network error. Try again." });
			setBusy(false);
			if (dead.length > 0) onDeleted(dead, revision);
		}
	};

	if (!nodes || nodes.length === 0) return null;

	return createPortal(
		<div className="v4 scope">
			<div className="overlay" {...backdropDismiss}>
				<DeleteNodeBody
					nodes={nodes}
					busy={busy}
					failure={failure}
					onClose={onClose}
					onRun={() => void run()}
				/>
			</div>
		</div>,
		document.body,
	);
}
