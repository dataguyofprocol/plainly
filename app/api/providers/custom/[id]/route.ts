/**
 * PUT /api/providers/custom/:id — partial update (custom-endpoint wave,
 * 2026-10-26). Body any of {name, baseUrl, models, apiKey}: apiKey a
 * string replaces the key, null removes it, absent leaves it. The id
 * never changes, so slot pins survive a rename. {provider}; 404 unknown
 * id; 400 with a user-facing `error` on a bad field.
 *
 * DELETE — remove the provider and its key. 204; 404 unknown id. Slots
 * pinned to it are left as they are — the lapsed-pin handling reports
 * them.
 */
import { parseCustomProviderUpdate } from "@/src/core";
import { deleteCustomProvider, updateCustomProvider } from "@/src/server";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function PUT(req: Request, { params }: Params) {
	const { id } = await params;
	const body = await req.json().catch(() => null);
	const parsed = parseCustomProviderUpdate(body);
	if (!parsed.ok) return Response.json({ error: parsed.error }, { status: 400 });
	const provider = updateCustomProvider(id, parsed.value);
	if (!provider) return Response.json({ error: `unknown provider "${id}"` }, { status: 404 });
	return Response.json({ provider });
}

export async function DELETE(_req: Request, { params }: Params) {
	const { id } = await params;
	if (!deleteCustomProvider(id)) return Response.json({ error: `unknown provider "${id}"` }, { status: 404 });
	return new Response(null, { status: 204 });
}
