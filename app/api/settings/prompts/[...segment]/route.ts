/**
 * The override text for one prompt segment.
 *
 *   PUT {text}: 200. The segment must be a current source segment, else 400.
 *   DELETE: idempotent. Removes the override file and clears the segment's
 *          switch in agent.prompts; switchCleared says whether it was on.
 */

import {
	allSegmentPaths,
	isValidSegmentPath,
	promptOverrides,
	readSettingsRecord,
	writeSettingsRecord,
} from "@/src/server";

export const dynamic = "force-dynamic";

function segmentPathFrom(segments: string[]): string | null {
	const joined = segments.map(decodeURIComponent).join("/");
	return isValidSegmentPath(joined) ? joined : null;
}

export async function PUT(request: Request, ctx: { params: Promise<{ segment: string[] }> }) {
	const { segment } = await ctx.params;
	const path = segmentPathFrom(segment);
	if (!path) return Response.json({ error: "invalid segment path" }, { status: 400 });
	const body = (await request.json().catch(() => null)) as { text?: unknown } | null;
	if (!body || typeof body.text !== "string") {
		return Response.json({ error: "body must be {text: string}" }, { status: 400 });
	}
	if (!new Set(allSegmentPaths()).has(path)) {
		return Response.json(
			{ error: `"${path}" is not a current source segment`, supported: allSegmentPaths() },
			{ status: 400 },
		);
	}
	promptOverrides.writeOverride(path, body.text);
	return Response.json({ path, text: body.text });
}

export async function DELETE(_request: Request, ctx: { params: Promise<{ segment: string[] }> }) {
	const { segment } = await ctx.params;
	const path = segmentPathFrom(segment);
	if (!path) return Response.json({ error: "invalid segment path" }, { status: 400 });
	const record = readSettingsRecord();
	const hadSwitch = record?.agent?.prompts?.[path] === true;
	if (record && record.agent?.prompts?.[path] !== undefined) {
		const prompts = { ...record.agent.prompts };
		delete prompts[path];
		writeSettingsRecord({ ...record, agent: { ...record.agent, prompts } });
	}
	promptOverrides.deleteOverride(path);
	return Response.json({ path, deleted: true, switchCleared: hadSwitch });
}
