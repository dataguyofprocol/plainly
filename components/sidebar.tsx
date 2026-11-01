"use client";

import { useEffect } from "react";
import { CommandPalette } from "@/components/command-palette";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { SettingsDialogProvider } from "@/components/settings/settings-dialog.tsx";
import { notifySettingsSaved } from "@/components/settings-signal";
import { TimeBeacon } from "@/components/v4/time-beacon";
import type { ChatGPTControlBridge, NativeSubscriptionControlBridge } from "@/src/core";

const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

declare global {
	interface Window {
		lh?: {
			platform?: string;
			chatgpt?: ChatGPTControlBridge;
			subscriptions?: NativeSubscriptionControlBridge;
			onZoom?: (cb: (factor: number) => void) => () => void;
			getZoom?: () => Promise<number>;
			onUpdateStatus?: (cb: (status: { status: string; version: string | null }) => void) => () => void;
			installUpdate?: () => void;
			pathForFile?: (file: File) => string;
		};
	}
}

export function ShellProvider({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		const bridge = window.lh?.chatgpt;
		if (!bridge) return;
		const off = bridge.onChange(() => notifySettingsSaved("keys"));
		notifySettingsSaved("keys");
		return off;
	}, []);
	useEffect(() => {
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
		// A file dropped where no composer claims it must not navigate the window
		// to file:// (Electron's will-navigate would bounce it to Preview).
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

export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<SettingsDialogProvider>
			{children}
			<CommandPalette />
			<KeyboardShortcuts />
			<TimeBeacon />
		</SettingsDialogProvider>
	);
}

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
