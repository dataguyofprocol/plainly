import { eventsResponse } from "@/src/server";

export const dynamic = "force-dynamic";

export function GET(): Response {
	return eventsResponse();
}
