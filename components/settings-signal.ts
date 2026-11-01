"use client";

import { useEffect, useRef } from "react";

export const SETTINGS_SAVED_EVENT = "lh:settings-saved";

export type SettingsSection = "general" | "keys" | "agent" | "models" | "appearance" | "graph" | "compaction";

export function notifySettingsSaved(section: SettingsSection): void {
	window.dispatchEvent(
		new CustomEvent(SETTINGS_SAVED_EVENT, { detail: { section } }),
	);
}

export function onSettingsSaved(handler: (section: SettingsSection) => void): () => void {
	const listener = (e: Event) => {
		const section = (e as CustomEvent<{ section?: SettingsSection }>).detail?.section;
		if (section !== undefined) handler(section);
	};
	window.addEventListener(SETTINGS_SAVED_EVENT, listener);
	return () => window.removeEventListener(SETTINGS_SAVED_EVENT, listener);
}

export function useSettingsSaved(handler: (section: SettingsSection) => void): void {
	const saved = useRef(handler);
	saved.current = handler;
	useEffect(() => onSettingsSaved((section) => saved.current(section)), []);
}