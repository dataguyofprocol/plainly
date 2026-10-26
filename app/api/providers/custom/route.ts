/**
 * GET /api/providers/custom — the user's OpenAI-compatible endpoints
 * (custom-endpoint wave, 2026-10-26): {providers: [{id, name, baseUrl,
 * models, keyPresent}]}. Keys never leave the store — keyPresent only.
 *
 * POST — add one. Body {name, baseUrl, apiKey?, models}: strict parse
 * (core/custom-providers.ts; a bad field is a 400 with a user-facing
 * `error`). The id is minted from the name ("custom-" + slug, -2, -3 …
 * on collision) and never changes. A key is optional — local servers
 * need none. 201 {provider}; its models join the pickers immediately.
 */
import { parseCustomProviderCreate } from "@/src/core";
import { createCustomProvider, listCustomProviders } from "@/src/server";

export const dynamic = "force-dynamic";

export async function GET() {
	return Response.json({ providers: listCustomProviders() });
}

export async function POST(req: Request) {
	const body = await req.json().catch(() => null);
	const parsed = parseCustomProviderCreate(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	return Response.json({ provider: createCustomProvider(parsed.value) }, { status: 201 });
}
