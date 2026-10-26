/**
 * The active-learning TIME LEDGER — the fs JSONL adapter (v4 redesign,
 * owner-approved 2026-10-26). One append-only file per LOCAL month at
 * config PATHS.time/YYYY-MM.jsonl; each line is one heartbeat
 * {chatId, at, seconds} (core/contracts/activity.ts TimeBeat). Aggregates
 * are pure folds over the lines (core/activity.ts) — nothing else is
 * stored, nothing is ever rewritten.
 *
 * Idioms: sync fs like the other adapters; a torn or foreign line is
 * skipped on read (one bad line never blanks the ledger). Reads are
 * memoized per file by (mtime, size) on globalThis — the list route and
 * the stats routes read the whole ledger on every call, and a year of
 * beats is ~10^5 lines: re-parsing only what changed keeps them cheap.
 */

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

/** The parse memo (globalThis — Next dev compiles each route entry as its
 *  own module instance; one process, one memo). Keyed by absolute path,
 *  so a relocated data dir (tests) never reads another dir's memo. */
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

/** Append one beat to its LOCAL month's file (the caller has clamped and
 *  validated; a zero-second beat is the caller's no-op to skip). */
function appendBeat(beat: TimeBeat): void {
	fs.mkdirSync(PATHS.time, { recursive: true });
	const file = path.join(PATHS.time, `${localMonthKey(new Date(beat.at))}.jsonl`);
	fs.appendFileSync(file, `${JSON.stringify(beat)}\n`, "utf-8");
}

/** Every beat, month files in order. Empty when no ledger exists yet. */
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
