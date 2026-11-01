import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.dirname(fileURLToPath(import.meta.url));

/**
 * Test sandbox: a test process never resolves the learner's real data.
 * Under NODE_ENV=test with no LH_DATA_DIR, the data root is a fresh temp
 * dir for this process, published back to the env so child processes share
 * it, and removed on exit. Tests that set LH_DATA_DIR before importing app
 * modules are unaffected.
 */
function testSandbox(): string | null {
	if (process.env.NODE_ENV !== "test" || process.env.LH_DATA_DIR) return null;
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-test-data-"));
	process.env.LH_DATA_DIR = dir;
	process.env.LH_AUTH_FILE ??= path.join(dir, "auth.json");
	process.once("exit", () => fs.rmSync(dir, { recursive: true, force: true }));
	return dir;
}
const TEST_SANDBOX = testSandbox();

/**
 * The data-location seam: LH_DATA_DIR relocates every mutable record (chat
 * sessions, graph ledgers, the embedding model cache). The desktop shell
 * points it at userData because the .app bundle is read-only (macOS
 * translocation). Unset, it resolves to the repo's data/, except in tests
 * (the sandbox above). Read-only assets (prompts) stay ROOT-anchored
 * because they ship inside the app bundle.
 */
const DATA_ROOT = TEST_SANDBOX ?? (process.env.LH_DATA_DIR ? path.resolve(process.env.LH_DATA_DIR) : path.join(ROOT, "data"));

export const PATHS = {
	root: ROOT,
	teacherPrompt: path.join(ROOT, "src", "agent", "system-prompt.md"),
	data: DATA_ROOT,
	chats: path.join(DATA_ROOT, "chats"),
	graph: path.join(DATA_ROOT, "graph"),
	/** Env-gated raw provider stream recordings: debug/provider-events/<chatId>.jsonl. */
	debug: path.join(DATA_ROOT, "debug"),
	/** One append-only JSONL file per local month, YYYY-MM.jsonl, lines {chatId, at, seconds}. */
	time: path.join(DATA_ROOT, "time"),
} as const;

export const SUGGESTIONS_FILE = path.join(DATA_ROOT, "suggestions.json");

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export type ModelRole =
	| "prober"
	| "teacher"
	| "researcher"
	| "demoBuilder"
	| "visualMaker"
	| "pdfReader"
	| "extractor"
	| "auditor";

export const LEDGER_FILES = {
	nodes: path.join(PATHS.graph, "nodes.jsonl"),
	chains: path.join(PATHS.graph, "chains.jsonl"),
	sessions: path.join(PATHS.graph, "sessions.jsonl"),
	coverage: path.join(PATHS.graph, "coverage.jsonl"),
} as const;

export const SOURCES_FILE = path.join(PATHS.graph, "sources.json");
export const POSITIONS_FILE = path.join(PATHS.graph, "positions.json");

export const RENDER_SETTINGS_FILE = path.join(PATHS.graph, "render-settings.json");

/** One format version for the four JSONL ledgers, sources.json and
 *  render-settings.json. Absent means v1. positions.json is rebuildable and
 *  unversioned. */
export const GRAPH_FORMAT_FILE = path.join(PATHS.graph, "format.json");

/**
 * Delta-shaped, non-secret settings: absent keys resolve to FACTORY_SETTINGS,
 * so a new knob needs no migration. `version` counts breaking shape changes
 * only, not app releases.
 */
export const SETTINGS_FILE = path.join(DATA_ROOT, "settings.json");

/**
 * Per-segment prompt overrides mirroring src/agent/prompts/. A file is used
 * only while settings.json agent.prompts[segmentPath] is true.
 */
export const PROMPTS_OVERRIDE_DIR = path.join(DATA_ROOT, "prompts");

/**
 * BYOK provider keys as a flat {VAR: value} JSON map, re-read on every
 * access. The desktop shell passes LH_AUTH_FILE (userData/auth.json); dev
 * defaults to the repo-root auth.json. Real environment variables win over
 * this file.
 */
export const AUTH_FILE = process.env.LH_AUTH_FILE
	? path.resolve(process.env.LH_AUTH_FILE)
	: path.join(ROOT, "auth.json");
