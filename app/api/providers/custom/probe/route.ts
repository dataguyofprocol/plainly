/**
 * POST /api/providers/custom/probe {baseUrl, apiKey?, providerId?}: calls
 * GET {baseUrl}/models. providerId uses that saved provider's key when no
 * apiKey is given. Always 200: {ok: true, models, detected} or
 * {ok: false, error} with a user-facing reason. A malformed body is 400.
 */
import { parseCustomProviderProbe } from "@/src/core";
import { probeCustomProvider } from "@/src/server";

export const dynamic = "force-dynamic";

export async function POST(req: Request) {
	const body = await req.json().catch(() => null);
	const parsed = parseCustomProviderProbe(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	return Response.json(await probeCustomProvider(parsed.value));
}
