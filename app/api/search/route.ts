/**
 * GET /api/search: { available, engine, reason }. `engine` is the active
 * search engine; the response never carries a key.
 */
import { searchStatus } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json(searchStatus());
}
