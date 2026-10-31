"use client";

/**
 * The app frame (v4 rebuild, 2026-10-26). The sidebar itself moved into
 * the screens (components/v4/shell.tsx — each v4 screen frames itself with
 * the sidebar card or the rail, as the artboards do); what stays here is
 * the root-level machinery every screen shares:
 *
 *   ShellProvider  Electron detection (the .lh-electron drag CSS), the
 *                  zoom truth for the traffic-light gutters, and the
 *                  ChatGPT bridge's key-change signal
 *   AppShell       the settings dialog, the ⌘K omnibar, the keyboard
 *                  registry, and the active-time beacon
 */

import { useEffect } from "react";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { SettingsDialogProvider } from "@/components/settings/settings-dialog.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";
import { TimeBeacon } from "@/components/v4/time-beacon";
import type { ChatGPTControlBridge, NativeSubscriptionControlBridge } from "@/src/core";

// Module scope, guarded for SSR (the server has no navigator).
const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

declare global {
	interface Window {
		/** Preload bridge (electron/preload.cjs) — Electron only, absent in the browser. */
		lh?: {
			/** Read-only host OS; determines the native-control gutter. */
			platform?: string;
			chatgpt?: ChatGPTControlBridge;
			subscriptions?: NativeSubscriptionControlBridge;
			/** The zoom truth (owner round 7): subscribes to "lh:zoom" pushes; returns unsubscribe. */
			onZoom?: (cb: (factor: number) => void) => () => void;
			getZoom?: () => Promise<number>;
			/** Auto-update channel (Wave C, 2026-10-10): "lh:update-status" pushes once a staged update exists. */
			onUpdateStatus?: (cb: (status: { status: string; version: string | null }) => void) => () => void;
			installUpdate?: () => void;
			/** Attachments (2026-10-31): a File's absolute disk path; "" when it has none. */
			pathForFile?: (file: File) => string;
		};
	}
}

export function ShellProvider({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		const bridge = window.lh?.chatgpt;
		if (!bridge) return;
		const off = bridge.onChange(() => notifySettingsSaved("keys"));
		notifySettingsSaved("keys"); // cover changes missed before this root-lifetime subscription
		return off;
	}, []);
	useEffect(() => {
		// Electron shell detection (merged chrome, 2026-09-17): keys the
		// .lh-electron CSS that turns header bands into the window's drag
		// surface. Post-mount only — server HTML and first client render
		// must agree; in the plain browser the class never appears.
		if (IS_ELECTRON) {
			document.documentElement.classList.add("lh-electron");
			document.documentElement.dataset.lhPlatform = window.lh?.platform ?? "";
		}
		// THE ZOOM TRUTH (owner round 7): ⌘±/⌘0 zoom the UI while the native
		// traffic lights stay physical-fixed — the gutter lengths divide by
		// this factor so their rendered size never moves.
		const setZoomVar = (factor: number) => document.documentElement.style.setProperty("--lh-zoom", String(factor));
		const off = window.lh?.onZoom?.(setZoomVar);
		void window.lh?.getZoom?.().then(setZoomVar);
		return () => off?.();
	}, []);
	useEffect(() => {
		// THE STRAY-DROP GUARD (attachments, 2026-10-31): a file dropped
		// where no composer claims it must not navigate the window to
		// file:// (Electron's will-navigate would bounce it to Preview).
		// A composer's own handler runs first and claims the drop; anything
		// left over is refused ("none" — no copy cursor where it can't land).
		const refuse = (e: DragEvent) => {
			if (!e.dataTransfer?.types.includes("Files") || e.defaultPrevented) return;
			e.preventDefault();
			if (e.type === "dragover") e.dataTransfer.dropEffect = "none";
		};
		window.addEventListener("dragover", refuse);
		window.addEventListener("drop", refuse);
		return () => {
			window.removeEventListener("dragover", refuse);
			window.removeEventListener("drop", refuse);
		};
	}, []);
	return <>{children}</>;
}

/** The app frame: rendered once in the root layout. */
export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<SettingsDialogProvider>
			{children}
			<CommandPalette />
			{/* The single document-level keydown listener (keyboard wave A). */}
			<KeyboardShortcuts />
			<TimeBeacon />
		</SettingsDialogProvider>
	);
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago", then
 *  the ISO date (unambiguous in any locale, and it sorts). Pure — exported
 *  for tests and the extraction-coverage block. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}
