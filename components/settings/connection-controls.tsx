"use client";
/**
 * The connection kit shared by the ChatGPT and native-subscription flows:
 * a settings row (mark + name, optional account picker, one action), the
 * dialog's action bar, and the dialog itself (focus-trapped, Esc closes,
 * stacked above Settings). Styles: app/ui/settings.css.
 */
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { Button } from "@/components/ui/button";

/** A provider's mark: its initial on a quiet tile, drawn by CSS so the
 *  row's text (and accessible name) stays the provider's name alone. */
export function ProviderMark({ label, className }: { label: string; className?: string }) {
	return <span aria-hidden className={className ? `st-avatar ${className}` : "st-avatar"} data-initial={label.trim().charAt(0).toUpperCase()} />;
}

export function ConnectionRow({ label, action, disabled, onAction, children, testid, actionTestid }: { label: string; action: string; disabled: boolean; onAction: () => void; children?: React.ReactNode; testid?: string; actionTestid?: string }) {
	const connected = action !== "Connect";
	return <div className="st-conn items-center" data-testid={testid}>
		<span>
			<ProviderMark label={label} />
			{label}
			{connected && <span className="dot good" title="Connected" />}
		</span>
		{children}
		<Button type="button" size="sm" variant={connected ? "ghost" : "outline"} className={`cursor-pointer disabled:cursor-not-allowed ${connected ? "text-muted-foreground hover:text-foreground" : ""}`} data-testid={actionTestid} disabled={disabled} onClick={onAction}>{action}</Button>
	</div>;
}

export function ConnectionFooter({ leading, children, testid }: { leading?: React.ReactNode; children: React.ReactNode; testid?: string }) {
	return <div className="dlg-actions" data-testid={testid}>
		{leading}
		<div className="dlg-actions-r">{children}</div>
	</div>;
}

export function ConnectionDialog({ children, onClose, busy, label, testid, backdropTestid }: { children: React.ReactNode; onClose: () => void; busy: boolean; label: string; testid: string; backdropTestid: string }) {
	const ref = useRef<HTMLDivElement>(null), closeRef = useRef(onClose);
	closeRef.current = onClose;
	const backdropDismiss = useBackdropDismiss(() => { if (!busy) onClose(); });
	useEffect(() => {
		const previous = document.activeElement as HTMLElement | null;
		const focusable = () => [...(ref.current?.querySelectorAll<HTMLElement>('button:not([disabled]), a[href], input:not([disabled]), select:not([disabled])') ?? [])];
		focusable()[0]?.focus();
		const key = (event: KeyboardEvent) => {
			if (event.key === "Escape") { event.preventDefault(); event.stopImmediatePropagation(); closeRef.current(); }
			else if (event.key === "Tab") {
				const items = focusable(), first = items[0], last = items.at(-1);
				if (!first) { event.preventDefault(); return; }
				if (event.shiftKey && (document.activeElement === first || !ref.current?.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
				else if (!event.shiftKey && (document.activeElement === last || !ref.current?.contains(document.activeElement))) { event.preventDefault(); first.focus(); }
			}
		};
		document.addEventListener("keydown", key, true);
		return () => { document.removeEventListener("keydown", key, true); if (previous?.isConnected) previous.focus(); };
	}, []);
	return createPortal(<div className="v4 scope">
		<div className="overlay z60" data-testid={backdropTestid} {...backdropDismiss}>
			<div ref={ref} role="dialog" aria-modal="true" aria-label={label} aria-busy={busy} data-testid={testid} onClick={(event) => event.stopPropagation()} className="dialog pad conn">{children}</div>
		</div>
	</div>, document.body);
}
