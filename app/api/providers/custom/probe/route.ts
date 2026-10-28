/**
 * POST /api/providers/custom/probe — test an endpoint before saving it
 * (custom-endpoint wave, 2026-10-26). Body {baseUrl, apiKey?, providerId?}
 * — providerId sends a saved provider's stored key when no apiKey is
 * given; calls GET {baseUrl}/models (8s timeout) and answers 200 either
 * way: {ok: true, models, detected} (the capabilities the server
 * described, per model id) or {ok: false, error} with a user-facing reason
 * (unreachable / unauthorized / not OpenAI-compatible). Only a malformed
 * body is a 400. The static segment wins over [id], so "probe" is never
 * read as a provider id.
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
