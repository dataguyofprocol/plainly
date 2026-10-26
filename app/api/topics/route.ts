/**
 * GET /api/topics — the knowledge view's topics (v4 redesign, 2026-10-26;
 * shape: contracts/activity.ts TopicsResponse): one per snapshot cluster
 * (birth-session communities), newest-learned first, with when each was
 * last practiced (practice sessions started on its ideas).
 */
import { activityTopics } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ topics: activityTopics() });
}
