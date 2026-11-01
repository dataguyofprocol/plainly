import * as fs from "node:fs";
import path from "node:path";
import { PATHS } from "../../config.ts";

const CAP_BYTES = 20 * 1024 * 1024;

export const providerEventsCap = { current: CAP_BYTES };

export const providerEventsDir = { current: path.join(PATHS.debug, "provider-events") };

export interface ProviderEventModel {
	provider?: string;
	id?: string;
}

export type ProviderEventObserver = (data: unknown, model: ProviderEventModel) => void;

const files = new Map<string, { bytes: number; capped: boolean }>();

function fileFor(chatId: string): string {
	const safe = chatId.replace(/[^a-zA-Z0-9_-]/g, "_");
	return path.join(providerEventsDir.current, `${safe}.jsonl`);
}

function writeLine(file: string, line: Record<string, unknown>): void {
	const state = files.get(file);
	if (state?.capped) return;
	const text = `${JSON.stringify({ t: Date.now(), ...line })}\n`;
	try {
		const before = state?.bytes ?? (fs.existsSync(file) ? fs.statSync(file).size : 0);
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, text, "utf-8");
		const bytes = before + Buffer.byteLength(text);
		if (bytes > providerEventsCap.current) {
			files.set(file, { bytes, capped: true });
			fs.appendFileSync(file, `${JSON.stringify({ t: Date.now(), note: `cap ${providerEventsCap.current} bytes reached — recording stopped` })}\n`, "utf-8");
		} else {
			files.set(file, { bytes, capped: false });
		}
	} catch {
		// The debug recorder must never take a run down with it.
	}
}

function encodeEvent(data: unknown): unknown {
	try {
		JSON.stringify(data);
		return data;
	} catch {
		return { __nonSerializable: typeof data };
	}
}

export function providerEventsEnabled(): boolean {
	return !!process.env.LH_PROVIDER_EVENTS;
}

export function providerEventObserver(chatId: string, context: string): ProviderEventObserver | undefined {
	if (!providerEventsEnabled()) return undefined;
	return (data, model) => {
		writeLine(fileFor(chatId), {
			ctx: context,
			provider: model?.provider,
			model: model?.id,
			event: encodeEvent(data),
		});
	};
}

export function providerEventNote(chatId: string, context: string, text: string): void {
	if (!providerEventsEnabled()) return;
	writeLine(fileFor(chatId), { ctx: context, note: text });
}
