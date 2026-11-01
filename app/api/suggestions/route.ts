/**
 * GET /api/suggestions: answers from the disk cache and regenerates in the
 * background when stale. No cache yet -> {suggestions: [], generatedAt: null}.
 */
import { suggestionService } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(suggestionService().get());
}
