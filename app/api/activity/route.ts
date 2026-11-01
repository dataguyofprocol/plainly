import { activityFeed } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(activityFeed());
}
