/**
 * PUT /api/settings/[section]: the body replaces that one section whole;
 * other sections are untouched. 404 unknown section. 400 for a bad shape,
 * or for an unknown provider/model in the chat or models section. A pinned
 * thinking level clamps to the model's nearest supported level. In the
 * agent section, an ON prompt switch whose override file is gone is
 * dropped, not rejected.
 */

import type { AgentSettings, ChatSettings, ModelsSettings } from "@/src/core";
import {
	SETTINGS_SECTIONS,
	allSegmentPaths,
	clampChatLevel,
	clampModelsLevels,
	effectiveSettings,
	promptOverrides,
	readSettingsRecord,
	validateChatSettings,
	validateModelsSettings,
	writeSettingsRecord,
	type SettingsBodyResult,
} from "@/src/server";

export const dynamic = "force-dynamic";

type AnySectionParser = (body: unknown) => SettingsBodyResult<unknown>;

export async function PUT(request: Request, ctx: { params: Promise<{ section: string }> }) {
	const { section } = await ctx.params;
	const parser = (SETTINGS_SECTIONS as Record<string, AnySectionParser>)[section];
	if (!parser) {
		return Response.json(
			{ error: `unknown settings section "${section}"`, supported: Object.keys(SETTINGS_SECTIONS) },
			{ status: 404 },
		);
	}
	const body = await request.json().catch(() => null);
	const parsed = parser(body);
	if (!parsed.ok) {
		return Response.json({ error: parsed.error }, { status: 400 });
	}
	let agentHealed: AgentSettings | undefined;

	if (section === "chat") {
		const verdict = validateChatSettings(parsed.settings as ChatSettings);
		if (!verdict.ok) {
			return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
		}
	}
	if (section === "models") {
		const verdict = validateModelsSettings(parsed.settings as ModelsSettings);
		if (!verdict.ok) {
			return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
		}
	}
	if (section === "agent") {
		const agent = parsed.settings as AgentSettings;
		const segments = new Set(allSegmentPaths());
		const orphans: string[] = [];
		for (const [path, on] of Object.entries(agent.prompts ?? {})) {
			if (on && (!segments.has(path) || promptOverrides.readOverride(path) === null)) orphans.push(path);
		}
		if (orphans.length > 0) {
			const prompts = { ...(agent.prompts ?? {}) };
			for (const path of orphans) delete prompts[path];
			agentHealed = { ...agent, prompts };
			console.info(`[settings] healed orphaned prompt switch(es) to off: ${orphans.join(", ")}`);
		}
	}

	const sectionOut =
		section === "chat"
			? clampChatLevel(parsed.settings as ChatSettings, effectiveSettings().models.strong)
			: section === "models"
				? clampModelsLevels(parsed.settings as ModelsSettings)
				: section === "agent" && agentHealed
					? agentHealed
					: parsed.settings;

	const record = readSettingsRecord() ?? { version: 1 };
	const next = { ...record, [section]: sectionOut };
	writeSettingsRecord(next);
	return Response.json({ settings: next });
}
