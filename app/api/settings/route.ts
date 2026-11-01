/**
 *   GET -> 200 {settings}: the sanitized delta record, where an absent key
 *          means the factory default; {settings: null} before the first write.
 */

import { settingsStore } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ settings: settingsStore.readSettings() });
}
