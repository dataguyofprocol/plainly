/**
 * GET /api/stats/daily — the home's week strip (v4 redesign, 2026-10-26;
 * shape: contracts/activity.ts DailyStatsResponse): the current week
 * Monday → Sunday in local days, minutes per day against the resolved
 * general.dailyGoalMinutes.
 */
import { activityDaily } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(activityDaily());
}
