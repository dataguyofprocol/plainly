import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	extractionEnabled,
	graphToolsEnabled,
	renderingEnabled,
	resolveConversationSpec,
	resolveModelSpec,
	resolveRoleSpec,
	resolveSettings,
	resolveSlot,
} from "../src/core/settings-resolution.ts";
import { BACKGROUND_MODEL_ROLES, type UserSettings } from "../src/core/settings.ts";

describe("resolveSettings", () => {
	it("null record (first boot): non-model knobs land on factory defaults; every model view is EMPTY", () => {
		const eff = resolveSettings(null);
		assert.deepEqual(eff.general, { dailyGoalMinutes: 30 });
		assert.deepEqual(eff.agent.tools, {});
		assert.deepEqual(eff.agent.prompts, {});
		assert.deepEqual(eff.agent.search, {});
		for (const role of BACKGROUND_MODEL_ROLES) {
			assert.equal(eff.agent.models[role], undefined, role);
		}
		assert.equal(eff.models.strong, null);
		assert.equal(eff.models.cheap, null);
		assert.equal(eff.models.vision, null);
		assert.equal(eff.appearance.mode, "system");
		assert.equal(eff.appearance.background, null);
		assert.equal(eff.appearance.fontFamily, null);
		assert.equal(eff.appearance.proseFontSize, 17);
		assert.equal(eff.appearance.sessionNameSerif, true);
		assert.equal(eff.appearance.mdRendering.headingWeight, 600);
		assert.deepEqual(eff.graph, { enabled: true, rendering: true, extractionChunkTokens: 4096 });
	});

	it("explicit record values win over every factory default", () => {
		const record: UserSettings = {
			version: 1,
			general: { dailyGoalMinutes: 60 },
			agent: {
				models: { researcher: { model: { provider: "openrouter", id: "qwen/qwen3.8-flash" } } },
				tools: { research: false },
				prompts: { "system-prompt.md": true },
				search: { engine: "tavily" },
			},
			appearance: { mode: "light", proseFontSize: 20, mdRendering: { headingWeight: 600 } },
			graph: { enabled: false },
		};
		const eff = resolveSettings(record);
		assert.equal(eff.general.dailyGoalMinutes, 60);
		assert.deepEqual(eff.agent.models.researcher, {
			provider: "openrouter",
			id: "qwen/qwen3.8-flash",
			thinkingLevel: undefined,
		});
		assert.deepEqual(eff.agent.search, { engine: "tavily" });
		assert.deepEqual(eff.agent.tools, { research: false });
		assert.deepEqual(eff.agent.prompts, { "system-prompt.md": true });
		assert.equal(eff.appearance.mode, "light");
		assert.equal(eff.appearance.proseFontSize, 20);
		assert.equal(eff.appearance.mdRendering.headingWeight, 600);
		assert.deepEqual(eff.graph, { enabled: false, rendering: true, extractionChunkTokens: 4096 });
		assert.equal(renderingEnabled(eff.graph), true);
		const budgeted = resolveSettings({ version: 1, graph: { extractionChunkTokens: 2000 } });
		assert.deepEqual(budgeted.graph, { enabled: true, rendering: true, extractionChunkTokens: 2000 });
	});

	it("graph rendering (2026-10-06): display-only — off resolves off, extraction untouched", () => {
		const eff = resolveSettings({ version: 1, graph: { rendering: false } });
		assert.equal(eff.graph.rendering, false, "stored off wins");
		assert.equal(eff.graph.enabled, true, "the data channel is untouched");
		assert.equal(renderingEnabled(eff.graph), false);
		assert.equal(extractionEnabled(eff.graph), true);
		assert.equal(resolveSettings({ version: 1, graph: {} }).graph.rendering, true);
	});

	it("partial role override: thinkingLevel alone borrows the SLOT's model (or nothing, without one)", () => {
		const eff = resolveSettings({
			version: 1,
			models: { cheap: { model: { provider: "zai", id: "glm-5.3-flash" } } },
			agent: { models: { extractor: { thinkingLevel: "medium" } } },
		});
		assert.deepEqual(eff.agent.models.extractor, {
			provider: "zai",
			id: "glm-5.3-flash",
			thinkingLevel: "medium",
		});
		const bare = resolveSettings({ version: 1, agent: { models: { extractor: { thinkingLevel: "medium" } } } });
		assert.equal(bare.agent.models.extractor, undefined);
	});

	it("resolveModelSpec is field-independent per override aspect", () => {
		const slots = { cheap: { model: { provider: "zai", id: "slot-model" }, thinkingLevel: "high" as const } };
		assert.deepEqual(
			resolveModelSpec("auditor", { model: { provider: "other", id: "x" } }, slots),
			{ provider: "other", id: "x", thinkingLevel: "high" },
		);
		assert.deepEqual(resolveModelSpec("auditor", { thinkingLevel: "max" }, slots), {
			provider: "zai",
			id: "slot-model",
			thinkingLevel: "max",
		});
		assert.equal(resolveModelSpec("auditor", undefined, {}), undefined);
	});
});

describe("the slot tier (BYOK, owner 2026-09-22)", () => {
	it("slot alone re-tiers every role of its tier (no role overrides present)", () => {
		const eff = resolveSettings({ version: 1, models: { cheap: { model: { provider: "zai", id: "glm-5.3-flash" } } } });
		for (const role of ["researcher", "demoBuilder", "extractor", "auditor"] as const) {
			assert.deepEqual(
				eff.agent.models[role],
				{ provider: "zai", id: "glm-5.3-flash", thinkingLevel: undefined },
				role,
			);
		}
		assert.equal(eff.agent.models.visualMaker, undefined);
	});

	it("role override still beats the slot; each field independent", () => {
		const eff = resolveSettings({
			version: 1,
			agent: { models: { researcher: { model: { provider: "groq", id: "r-override" } } } },
			models: { cheap: { model: { provider: "zai", id: "r-slot" }, thinkingLevel: "high" } },
		});
		assert.deepEqual(eff.agent.models.researcher, {
			provider: "groq",
			id: "r-override",
			thinkingLevel: "high",
		});
		assert.deepEqual(eff.agent.models.auditor, { provider: "zai", id: "r-slot", thinkingLevel: "high" });
	});

	it("vision slot covers visualMaker AND pdfReader; level-only slots resolve as NULL", () => {
		const eff = resolveSettings({ version: 1, models: { vision: { model: { provider: "zai", id: "v-model" }, thinkingLevel: "max" } } });
		assert.deepEqual(eff.agent.models.visualMaker, { provider: "zai", id: "v-model", thinkingLevel: "max" });
		assert.deepEqual(eff.models.vision, { provider: "zai", id: "v-model", thinkingLevel: "max" });
		const inert = resolveSettings({ version: 1, models: { strong: { thinkingLevel: "medium" } } });
		assert.equal(inert.models.strong, null);
		assert.equal(inert.agent.models.researcher, undefined);
	});

	it("resolveSlot: configured iff the model is present", () => {
		assert.deepEqual(resolveSlot({ model: { provider: "zai", id: "m" }, thinkingLevel: "medium" }), {
			provider: "zai",
			id: "m",
			thinkingLevel: "medium",
		});
		assert.deepEqual(resolveSlot({ model: { provider: "zai", id: "m" } }), {
			provider: "zai",
			id: "m",
			thinkingLevel: undefined,
		});
		assert.equal(resolveSlot({ thinkingLevel: "medium" }), null);
		assert.equal(resolveSlot(undefined), null);
	});

	it("resolveRoleSpec: background roles and the conversation pair share the chain", () => {
		const record: UserSettings = {
			version: 1,
			models: { strong: { model: { provider: "zai", id: "strong-model" } } },
		};
		assert.deepEqual(resolveRoleSpec("prober", record), {
			provider: "zai",
			id: "strong-model",
			thinkingLevel: undefined,
		});
		const withOverride: UserSettings = {
			...record,
			agent: { models: { researcher: { model: { provider: "groq", id: "r" } } } },
		};
		assert.deepEqual(resolveRoleSpec("researcher", withOverride), { provider: "groq", id: "r", thinkingLevel: undefined });
		const visionRecord: UserSettings = {
			version: 1,
			models: { vision: { model: { provider: "zai", id: "v" }, thinkingLevel: "low" } },
		};
		assert.deepEqual(resolveRoleSpec("pdfReader", visionRecord), { provider: "zai", id: "v", thinkingLevel: "low" });
		assert.equal(resolveRoleSpec("teacher", null), undefined);
	});
});

describe("resolveConversationSpec (the turn gate's chain)", () => {
	it("chat.model over the strong slot; null when both empty", () => {
		assert.equal(resolveConversationSpec(undefined, null), null);
		assert.deepEqual(
			resolveConversationSpec(undefined, { provider: "zai", id: "s" }),
			{ provider: "zai", id: "s", thinkingLevel: undefined },
		);
		assert.deepEqual(
			resolveConversationSpec({ model: { provider: "groq", id: "c" } }, null),
			{ provider: "groq", id: "c", thinkingLevel: undefined },
		);
	});

	it("bare chat thinking level rides the strong slot's model", () => {
		assert.deepEqual(
			resolveConversationSpec({ thinkingLevel: "high" }, { provider: "zai", id: "s", thinkingLevel: "low" }),
			{ provider: "zai", id: "s", thinkingLevel: "high" },
		);
		assert.deepEqual(
			resolveConversationSpec({ model: { provider: "groq", id: "c" }, thinkingLevel: "max" }, null),
			{ provider: "groq", id: "c", thinkingLevel: "max" },
		);
		assert.deepEqual(resolveConversationSpec({ model: { provider: "groq", id: "c" } }, null), {
			provider: "groq",
			id: "c",
			thinkingLevel: undefined,
		});
	});
});

describe("the graph channel gates (the wave's seam honoring)", () => {
	it("WRITE channel (extraction): dies with the master switch — the ONLY graph setting since wave 7", () => {
		assert.equal(extractionEnabled({ enabled: true }), true);
		assert.equal(extractionEnabled({ enabled: false }), false);
	});

	it("the write gate rides resolveSettings' factory defaults (all on → open)", () => {
		const eff = resolveSettings(null);
		assert.equal(extractionEnabled(eff.graph), true);
		const off = resolveSettings({ version: 1, graph: { enabled: false } });
		assert.equal(extractionEnabled(off.graph), false);
	});

	it("PROBER GRAPH TOOLS gate (wave 7, owner ruling 2026-09-23): the agent toggle AND the graph master switch compose", () => {
		const graph = { enabled: true };
		assert.equal(graphToolsEnabled({ graph, agent: { graphTools: {} } }), true, "absent subsection = ON");
		assert.equal(graphToolsEnabled({ graph, agent: { graphTools: { enabled: true } } }), true);
		assert.equal(graphToolsEnabled({ graph, agent: { graphTools: { enabled: false } } }), false);
		const dead = { ...graph, enabled: false };
		assert.equal(graphToolsEnabled({ graph: dead, agent: { graphTools: { enabled: true } } }), false, "graph off kills the tools regardless of the toggle");
	});

	it("graphTools rides resolveSettings: absent record → the empty subsection (ON); a record's delta passes through", () => {
		const eff = resolveSettings(null);
		assert.deepEqual(eff.agent.graphTools, {});
		const off = resolveSettings({ version: 1, agent: { graphTools: { enabled: false } } });
		assert.deepEqual(off.agent.graphTools, { enabled: false });
	});
});