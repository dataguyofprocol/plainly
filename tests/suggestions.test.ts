import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SUGGESTION_CONTEXT_SIZE,
	buildSuggestionsPrompt,
	newestPropositions,
	parseSuggestions,
	sanitizeSuggestionsCache,
	suggestionsStale,
	type SuggestionsCache,
} from "../src/core/suggestions.ts";
import { createSuggestionService, suggestionUsageParts, type SuggestionGenerator } from "../src/server/suggestions.ts";
import type { CallUsage, GraphNode } from "../src/core/index.ts";

const node = (id: string, createdAt: string): GraphNode => ({ id, name: `name-${id}`, statement: `statement-${id}`, aliases: [], createdAt, provenance: [] });
const at = (day: number, hour = 10) => new Date(2026, 9, day, hour).toISOString();
const REPLY = '```json\n[{"title":"Taylor series","reason":"Builds on your derivative rules."},{"title":"Limits","reason":"Underpins continuity."},{"title":"Integrals","reason":"The inverse of what you hold."},{"title":"Extra","reason":"dropped"}]\n```';

describe("core/suggestions", () => {
	it("newest propositions: deduped by id (first line defines), newest first, capped", () => {
		const nodes = [node("a", at(1)), node("b", at(3)), node("a", at(9)), node("c", at(2))];
		assert.deepEqual(newestPropositions(nodes).map((n) => n.id), ["b", "c", "a"]);
		const many = Array.from({ length: 40 }, (_, i) => node(`n${i}`, new Date(2026, 0, 1, 0, i).toISOString()));
		assert.equal(newestPropositions(many).length, SUGGESTION_CONTEXT_SIZE);
		assert.equal(newestPropositions(many)[0]!.id, "n39");
	});

	it("staleness: no ideas never; no cache yes; once per local day; or 10 new ideas", () => {
		const now = new Date(2026, 9, 26, 15);
		const nodes = [node("a", at(20))];
		const cache = (generatedAt: string | null): SuggestionsCache => ({ version: 1, generatedAt, suggestions: [], runs: [] });
		assert.equal(suggestionsStale(null, [], now), false);
		assert.equal(suggestionsStale(null, nodes, now), true);
		assert.equal(suggestionsStale(cache(null), nodes, now), true);
		assert.equal(suggestionsStale(cache(at(26, 9)), nodes, now), false, "fresh today");
		assert.equal(suggestionsStale(cache(at(25, 23)), nodes, now), true, "yesterday's");
		const nine = Array.from({ length: 9 }, (_, i) => node(`x${i}`, at(26, 11)));
		assert.equal(suggestionsStale(cache(at(26, 9)), [...nodes, ...nine], now), false);
		assert.equal(suggestionsStale(cache(at(26, 9)), [...nodes, ...nine, node("y", at(26, 12))], now), true);
	});

	it("the prompt lists name: statement and the JSON contract", () => {
		const p = buildSuggestionsPrompt([node("a", at(1))]);
		assert.match(p, /- name-a: statement-a/);
		assert.match(p, /JSON array of exactly 3 objects/);
	});

	it("parser: tolerates fences, keeps 3 valid entries, [] on junk", () => {
		assert.deepEqual(parseSuggestions(REPLY).map((s) => s.title), ["Taylor series", "Limits", "Integrals"]);
		assert.deepEqual(parseSuggestions('[{"title":"","reason":"x"},{"title":"T","reason":"R"}]'), [{ title: "T", reason: "R" }]);
		assert.deepEqual(parseSuggestions("no json here"), []);
		assert.deepEqual(parseSuggestions("[not json]"), []);
		assert.deepEqual(parseSuggestions('{"title":"x"}'), []);
	});

	it("cache sanitizer degrades bad shapes", () => {
		assert.equal(sanitizeSuggestionsCache("x"), null);
		assert.deepEqual(sanitizeSuggestionsCache({ generatedAt: 5, suggestions: [{ title: 1 }, { title: "t", reason: "r" }], runs: [{}] }), {
			version: 1,
			generatedAt: null,
			suggestions: [{ title: "t", reason: "r" }],
			runs: [],
		});
	});
});

describe("the suggestion service (injected generator)", () => {
	const STEP: CallUsage = { inputTokens: 100, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0 };

	function harness(opts: { reply?: string; throws?: boolean; generator?: boolean; nodes?: GraphNode[] } = {}) {
		const live = opts;
		let cache: SuggestionsCache | null = null;
		let calls = 0;
		let prompt = "";
		const gen: SuggestionGenerator = {
			model: "openrouter:cheap",
			run: async (_system, p, onStep) => {
				calls++;
				prompt = p;
				onStep(STEP);
				if (live.throws) throw new Error("provider down");
				return live.reply ?? REPLY;
			},
		};
		let clock = new Date(2026, 9, 26, 10);
		const service = createSuggestionService({
			readNodes: () => opts.nodes ?? [node("a", at(20))],
			readCache: () => cache,
			writeCache: (c) => {
				cache = c;
			},
			generator: () => (opts.generator === false ? null : gen),
			now: () => clock,
		});
		return {
			service,
			get cache() {
				return cache;
			},
			get calls() {
				return calls;
			},
			get prompt() {
				return prompt;
			},
			setReply(reply: string) {
				live.reply = reply;
			},
			tick(ms: number) {
				clock = new Date(clock.getTime() + ms);
			},
		};
	}

	it("no cache: answers [] immediately, generates in the background, serves it next read", async () => {
		const h = harness();
		assert.deepEqual(h.service.get(), { suggestions: [], generatedAt: null });
		assert.ok(h.service.pending(), "a generation was kicked");
		assert.equal(h.service.get().suggestions.length, 0, "single-flight: no second kick while one runs");
		await h.service.pending();
		assert.equal(h.calls, 1);
		assert.match(h.prompt, /name-a: statement-a/);
		const next = h.service.get();
		assert.equal(next.suggestions.length, 3);
		assert.equal(next.generatedAt, new Date(2026, 9, 26, 10).toISOString());
		assert.equal(h.service.pending(), null, "fresh today — no kick");
		assert.equal(h.cache!.runs.length, 1);
		assert.deepEqual(h.cache!.runs[0], { at: next.generatedAt, model: "openrouter:cheap", steps: [STEP], ok: true });
	});

	it("no generator (no cheap model / key): [] and nothing written", async () => {
		const h = harness({ generator: false });
		assert.deepEqual(h.service.get(), { suggestions: [], generatedAt: null });
		assert.equal(h.service.pending(), null);
		assert.equal(h.cache, null);
	});

	it("no propositions: nothing to generate from", () => {
		const h = harness({ nodes: [] });
		h.service.get();
		assert.equal(h.service.pending(), null);
	});

	it("failure: usage still recorded, suggestions stay [], cooldown holds further kicks", async () => {
		const h = harness({ throws: true });
		h.service.get();
		await h.service.pending();
		assert.deepEqual(h.service.get(), { suggestions: [], generatedAt: null });
		assert.equal(h.service.pending(), null, "cooling down");
		assert.equal(h.cache!.runs.length, 1);
		assert.equal(h.cache!.runs[0]!.ok, false);
		h.tick(11 * 60_000);
		h.service.get();
		assert.ok(h.service.pending(), "retries after the cooldown");
		await h.service.pending();
	});

	it("an unparseable reply is a failure that keeps the previous suggestions", async () => {
		const h = harness();
		h.service.get();
		await h.service.pending();
		const first = h.cache!;
		h.setReply("sorry, no JSON");
		h.tick(24 * 3_600_000);
		h.service.get();
		await h.service.pending();
		assert.deepEqual(h.cache!.suggestions, first.suggestions, "previous suggestions kept");
		assert.equal(h.cache!.generatedAt, first.generatedAt, "generatedAt stays the last success");
		assert.deepEqual(h.cache!.runs.map((r) => r.ok), [true, false], "both runs' spend recorded");
	});

	it("suggestion runs feed the stats' usage channel", () => {
		const parts = suggestionUsageParts({ version: 1, generatedAt: null, suggestions: [], runs: [{ at: at(26), model: "nope:unknown", steps: [STEP], ok: true }] });
		assert.deepEqual(parts, [{ at: at(26), tokens: 120, dollars: null }]);
	});
});
