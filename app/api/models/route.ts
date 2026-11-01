import { modelCatalog, refreshConnectionCatalog } from "@/src/server";

export async function GET() {
	await refreshConnectionCatalog();
	return Response.json(modelCatalog(), { headers: { "Cache-Control": "no-store" } });
}
