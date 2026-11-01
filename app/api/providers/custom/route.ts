/**
 * GET: {providers: [{id, name, baseUrl, models, keyPresent}]}. Keys never
 * leave the store.
 *
 * POST {name, baseUrl, apiKey?, models}: each model is a bare id or
 * {id, vision?, thinking?, thinkingFormat?, contextWindow?, maxTokens?}.
 * The id is minted from the name and never changes. 201 {provider}; a bad
 * field is 400 with a user-facing `error`.
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
