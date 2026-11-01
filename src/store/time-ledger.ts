import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import type { TimeBeat } from "../core/contracts.ts";
import { clampBeatSeconds, localMonthKey } from "../core/activity.ts";

const MONTH_FILE = /^\d{4}-\d{2}\.jsonl$/;

interface ParsedFile {
	mtimeMs: number;
	size: number;
	beats: TimeBeat[];
}

/** On globalThis because Next dev compiles each route entry as its own module instance. */
function memo(): Map<string, ParsedFile> {
	const g = globalThis as typeof globalThis & { __lhTimeLedgerMemo?: Map<string, ParsedFile> };
	return (g.__lhTimeLedgerMemo ??= new Map());
}

function parseLine(line: string): TimeBeat | null {
	try {
		const raw = JSON.parse(line) as Partial<TimeBeat>;
		if (typeof raw.chatId !== "string" || typeof raw.at !== "string" || !Number.isFinite(Date.parse(raw.at))) return null;
		return { chatId: raw.chatId, at: raw.at, seconds: clampBeatSeconds(raw.seconds) };
	} catch {
		return null;
	}
}

function readFile(file: string): TimeBeat[] {
	let st: fs.Stats;
	try {
		st = fs.statSync(file);
	} catch {
		return [];
	}
	const hit = memo().get(file);
	if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.beats;
	const beats = fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter((l) => l.trim().length > 0)
		.map(parseLine)
		.filter((b): b is TimeBeat => b !== null);
	memo().set(file, { mtimeMs: st.mtimeMs, size: st.size, beats });
	return beats;
}

/** The caller has clamped and validated the beat and skips zero-second beats. */
function appendBeat(beat: TimeBeat): void {
	fs.mkdirSync(PATHS.time, { recursive: true });
	const file = path.join(PATHS.time, `${localMonthKey(new Date(beat.at))}.jsonl`);
	fs.appendFileSync(file, `${JSON.stringify(beat)}\n`, "utf-8");
}

function readBeats(): TimeBeat[] {
	let names: string[];
	try {
		names = fs.readdirSync(PATHS.time).filter((n) => MONTH_FILE.test(n)).sort();
	} catch {
		return [];
	}
	return names.flatMap((n) => readFile(path.join(PATHS.time, n)));
}

export const timeLedger = { appendBeat, readBeats };
export type TimeLedger = typeof timeLedger;
