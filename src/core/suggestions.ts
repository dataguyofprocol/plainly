import type { CallUsage, GraphNode, Suggestion } from "./contracts.ts";
import { localDateKey } from "./activity.ts";

export interface SuggestionRunUsage {
	at: string;
	/** "provider:id". */
	model: string;
	steps: CallUsage[];
	ok: boolean;
}

export interface SuggestionsCache {
	version: 1;
	/** ISO time of the last successful generation; null before any. */
	generatedAt: string | null;
	suggestions: Suggestion[];
	runs: SuggestionRunUsage[];
}

export const SUGGESTION_CONTEXT_SIZE = 30;
/** New propositions since the last generation that force a fresh one
 *  even on the same local day. */
export const SUGGESTION_NEW_IDEAS_TRIGGER = 10;
export const SUGGESTION_COUNT = 3;

/** First occurrence per id wins; newest createdAt first. */
export function newestPropositions(nodes: readonly GraphNode[], limit = SUGGESTION_CONTEXT_SIZE): GraphNode[] {
	const seen = new Set<string>();
	const unique: GraphNode[] = [];
	for (const node of nodes) {
		if (seen.has(node.id)) continue;
		seen.add(node.id);
		unique.push(node);
	}
	return unique.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0)).slice(0, limit);
}

export function suggestionsStale(cache: SuggestionsCache | null, nodes: readonly GraphNode[], now: Date): boolean {
	const props = newestPropositions(nodes, Number.POSITIVE_INFINITY);
	if (props.length === 0) return false;
	const generatedAt = cache?.generatedAt;
	if (!generatedAt || !Number.isFinite(Date.parse(generatedAt))) return true;
	if (localDateKey(new Date(generatedAt)) !== localDateKey(now)) return true;
	return props.filter((n) => n.createdAt > generatedAt).length >= SUGGESTION_NEW_IDEAS_TRIGGER;
}

export const SUGGESTIONS_SYSTEM_PROMPT =
	"You suggest what a learner could study next. You receive the propositions most recently added to the learner's knowledge map and reply with exactly the JSON the instructions demand — nothing else, no preamble, no code fences.";

export function buildSuggestionsPrompt(props: readonly GraphNode[]): string {
	return [
		"The propositions most recently added to my knowledge map, newest first (name: statement):",
		"",
		...props.map((n) => `- ${n.name}: ${n.statement}`),
		"",
		`Suggest ${SUGGESTION_COUNT} topics I could learn next that build on these — each a natural next step from what I already hold, not a repeat of it, and distinct from each other.`,
		`Reply with ONLY a JSON array of exactly ${SUGGESTION_COUNT} objects: [{"title": "...", "reason": "..."}]. ` +
			"title: the topic, at most 60 characters. reason: one sentence, at most 140 characters, naming which of my propositions it builds on and why it is the next step.",
	].join("\n");
}

const TITLE_MAX = 80;
const REASON_MAX = 200;

const cap = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 1).trimEnd()}…`);

/** [] when nothing parses; the caller treats that as a failed generation. */
export function parseSuggestions(text: string): Suggestion[] {
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	if (start < 0 || end <= start) return [];
	let parsed: unknown;
	try {
		parsed = JSON.parse(text.slice(start, end + 1));
	} catch {
		return [];
	}
	if (!Array.isArray(parsed)) return [];
	const out: Suggestion[] = [];
	for (const entry of parsed) {
		const title = (entry as { title?: unknown } | null)?.title;
		const reason = (entry as { reason?: unknown } | null)?.reason;
		if (typeof title !== "string" || typeof reason !== "string") continue;
		if (!title.trim() || !reason.trim()) continue;
		out.push({ title: cap(title.trim(), TITLE_MAX), reason: cap(reason.trim(), REASON_MAX) });
		if (out.length === SUGGESTION_COUNT) break;
	}
	return out;
}

export function sanitizeSuggestionsCache(raw: unknown): SuggestionsCache | null {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
	const r = raw as Record<string, unknown>;
	const suggestions = Array.isArray(r.suggestions)
		? r.suggestions.filter(
				(s): s is Suggestion =>
					typeof (s as Suggestion)?.title === "string" && typeof (s as Suggestion)?.reason === "string",
			)
		: [];
	const runs = Array.isArray(r.runs)
		? r.runs.filter(
				(run): run is SuggestionRunUsage =>
					typeof (run as SuggestionRunUsage)?.at === "string" &&
					typeof (run as SuggestionRunUsage)?.model === "string" &&
					Array.isArray((run as SuggestionRunUsage)?.steps),
			)
		: [];
	return {
		version: 1,
		generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : null,
		suggestions,
		runs,
	};
}
