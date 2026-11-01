import {
	clampChatLevel,
	effectiveSettings,
	getChat,
	parseSettingsBody,
	stores,
	validateChatSettings,
} from "@/src/server";
import type { ChatSettings } from "@/src/core";

/**
 * Replaces the chat's settings whole; {} clears all overrides.
 * Unknown provider/model is 400. A pinned thinking level never rejects: it
 * clamps to the model's nearest supported level and the clamped value is stored.
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
	const { id } = await params;
	if (!getChat(id)) return Response.json({ error: "Not found" }, { status: 404 });

	const body = await req.json().catch(() => null);
	const parsed = parseSettingsBody(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });

	const verdict = validateChatSettings(parsed.settings);
	if (!verdict.ok) {
		return Response.json({ error: verdict.error, supported: verdict.supported }, { status: 400 });
	}

	const settings = clampChatLevel(parsed.settings, effectiveSettings().models.strong);
	stores.chatStore.saveSettings(id, settings);
	return Response.json({ settings });
}
