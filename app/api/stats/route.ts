/**
 * GET /api/stats?period=week|month — the home's period block (v4
 * redesign, 2026-10-26; shape: contracts/activity.ts StatsResponse).
 * "week" = Monday 00:00 local → now, "month" = the 1st → now; absent
 * period reads as week, any other value is a 400.
 */
import { activityStats } from "@/src/server";
import type { StatsPeriod } from "@/src/core";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
	const raw = new URL(req.url).searchParams.get("period") ?? "week";
	if (raw !== "week" && raw !== "month") {
		return Response.json({ error: 'period must be "week" or "month"' }, { status: 400 });
	}
	return Response.json(activityStats(raw as StatsPeriod));
}
