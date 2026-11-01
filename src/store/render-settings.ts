import fs from "node:fs";
import path from "node:path";
import { RENDER_SETTINGS_FILE } from "../../config.ts";
import { DEFAULT_RENDER_SETTINGS, sanitizeRenderSettings, type GraphRenderSettings } from "../core/render-settings.ts";
import { assertGraphFormat, ensureGraphFormat } from "./graph-format.ts";

/** Null when the file is missing, unreadable, or corrupt. */
export function readRenderSettings(): GraphRenderSettings | null {
	assertGraphFormat();
	let raw: string;
	try {
		raw = fs.readFileSync(RENDER_SETTINGS_FILE, "utf-8");
	} catch {
		return null;
	}
	try {
		return sanitizeRenderSettings(JSON.parse(raw));
	} catch {
		return null;
	}
}

/** Returns the sanitized settings that were written. */
export function writeRenderSettings(raw: unknown): GraphRenderSettings {
	const settings = sanitizeRenderSettings(raw);
	fs.mkdirSync(path.dirname(RENDER_SETTINGS_FILE), { recursive: true });
	ensureGraphFormat();
	fs.writeFileSync(RENDER_SETTINGS_FILE, JSON.stringify(settings, null, "\t"), "utf-8");
	return settings;
}

export { DEFAULT_RENDER_SETTINGS };
