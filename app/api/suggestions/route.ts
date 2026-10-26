/**
 * GET /api/suggestions — three "next from your graph" topics (v4
 * redesign, 2026-10-26; shape: contracts/activity.ts SuggestionsResponse).
 * NEVER BLOCKS: answers from the disk cache and kicks a background
 * generation on the cheap slot when stale (server/suggestions.ts). No
 * cache yet → {suggestions: [], generatedAt: null}.
 */
import { suggestionService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(suggestionService().get());
}
