import fs from "node:fs";
import path from "node:path";
import { GRAPH_FORMAT_FILE } from "../../config.ts";
import { CURRENT_GRAPH_FORMAT_VERSION } from "../core/contracts/graph.ts";

function stampedVersion(): number | null {
	let raw: string;
	try {
		raw = fs.readFileSync(GRAPH_FORMAT_FILE, "utf-8");
	} catch {
		return null;
	}
	try {
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "number" && Number.isInteger(parsed.version) ? parsed.version : null;
	} catch {
		return null;
	}
}

/** Throws when the data dir is stamped by a newer build. Never writes. */
export function assertGraphFormat(): void {
	const v = stampedVersion();
	if (v !== null && v > CURRENT_GRAPH_FORMAT_VERSION) {
		throw new Error(
			`Graph data is stamped with format version ${v}, but this build understands only ${CURRENT_GRAPH_FORMAT_VERSION}. ` +
				"The app is older than its data — upgrade the app before touching the knowledge map.",
		);
	}
}

/** Call before every graph-family write. No sidecar (or a corrupt one) means v1. */
export function ensureGraphFormat(): void {
	if (stampedVersion() !== null) return;
	fs.mkdirSync(path.dirname(GRAPH_FORMAT_FILE), { recursive: true });
	fs.writeFileSync(GRAPH_FORMAT_FILE, JSON.stringify({ version: CURRENT_GRAPH_FORMAT_VERSION }, null, "\t") + "\n", "utf-8");
}
