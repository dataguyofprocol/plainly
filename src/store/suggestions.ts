import * as fs from "node:fs";
import * as path from "node:path";
import { SUGGESTIONS_FILE } from "../../config.ts";
import { sanitizeSuggestionsCache, type SuggestionsCache } from "../core/suggestions.ts";

function readCache(): SuggestionsCache | null {
	try {
		return sanitizeSuggestionsCache(JSON.parse(fs.readFileSync(SUGGESTIONS_FILE, "utf-8")));
	} catch {
		return null;
	}
}

function writeCache(cache: SuggestionsCache): void {
	fs.mkdirSync(path.dirname(SUGGESTIONS_FILE), { recursive: true });
	const tmp = `${SUGGESTIONS_FILE}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, JSON.stringify(cache, null, "\t"), "utf-8");
	fs.renameSync(tmp, SUGGESTIONS_FILE);
}

export const suggestionsStore = { readCache, writeCache };
export type SuggestionsStore = typeof suggestionsStore;
