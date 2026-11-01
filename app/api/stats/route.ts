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
