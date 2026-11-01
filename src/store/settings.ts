import fs from "node:fs";
import path from "node:path";
import { SETTINGS_FILE } from "../../config.ts";
import {
	sanitizeUserSettings,
	type UserSettings,
} from "../core/settings.ts";
import type { SettingsStore } from "../core/ports.ts";

/** Null when the file is missing or corrupt. */
export function readSettings(): UserSettings | null {
	let raw: string;
	try {
		raw = fs.readFileSync(SETTINGS_FILE, "utf-8");
	} catch {
		return null;
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}
	const record = sanitizeUserSettings(parsed);
	if (!record) return null;
	return record;
}

/** Returns the sanitized record that was written. */
export function writeSettings(raw: unknown): UserSettings {
	const settings = sanitizeUserSettings(raw);
	if (!settings) throw new Error("settings record must be a JSON object");
	fs.mkdirSync(path.dirname(SETTINGS_FILE), { recursive: true });
	fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, "\t"), "utf-8");
	return settings;
}

export const settingsStore: SettingsStore = {
	readSettings,
	writeSettings,
};
