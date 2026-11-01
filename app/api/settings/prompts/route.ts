/**
 *   GET -> 200 {prober: SegmentInfo[], teacher: SegmentInfo[]}
 *   SegmentInfo = {path, sourceText, overrideText, enabled, shared}
 *
 * The shared base appears in both lists under the same path.
 */

import { effectivePromptSegments, readSettingsRecord } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	const switches = readSettingsRecord()?.agent?.prompts ?? {};
	return Response.json({
		prober: effectivePromptSegments("prober", switches),
		teacher: effectivePromptSegments("teacher", switches),
	});
}
