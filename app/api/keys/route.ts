/**
 * GET /api/keys: masked key statuses (last 4 + length; plaintext never
 * leaves the store) and `providers`, {id, envVar, label} for every pi-ai
 * plain-key provider.
 */
import { keyStatuses, providerKeyList } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ keys: keyStatuses(), providers: providerKeyList() });
}
