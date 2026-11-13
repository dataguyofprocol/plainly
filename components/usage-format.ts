import { isCustomProviderId, type ModelCatalogEntry } from "@/src/core";

export function formatUsd(c: number): string {
	return c >= 1 ? `$${c.toFixed(2)}` : `$${c.toFixed(4)}`;
}

export const COST_NOT_TRACKED = "Not tracked";

export function planCostLabel(dollars: number | null, subscription: boolean | string | readonly string[] | undefined, format = formatUsd): string {
	const labels = subscription === true ? ["ChatGPT"] : typeof subscription === "string" ? [subscription] : Array.isArray(subscription) ? [...new Set(subscription)] : [];
	return [...(dollars === null ? [] : [format(dollars)]), ...labels].join(" + ") || COST_NOT_TRACKED;
}

export function formatTokens(n: number): string {
	if (n >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
	if (n >= 1e3) return `${+(n / 1e3).toFixed(1)}k`;
	return String(n);
}

export function splitQualified(id: string): { provider: string | null; id: string } {
	const colon = id.indexOf(":");
	if (colon === -1) return { provider: null, id };
	return { provider: id.slice(0, colon), id: id.slice(colon + 1) };
}

/** Custom-provider models show their catalog name (display name, or the
 *  prettified id); built-in models keep `prettyModel`. */
export function modelLabel(
	id: string,
	provider: string | undefined,
	models: readonly ModelCatalogEntry[] | null | undefined,
): string {
	if (provider && isCustomProviderId(provider)) {
		const entry = models?.find((m) => m.id === id && m.provider === provider);
		if (entry) return entry.name;
	}
	return prettyModel(id);
}

export function prettyModel(id: string, qualified = false): string {
	const { provider, id: bare } = splitQualified(id);
	const short = bare.includes("/") ? bare.slice(bare.lastIndexOf("/") + 1) : bare;
	const parts = short.split("-");
	const trimmed = /^\d+$/.test(parts[parts.length - 1] ?? "") ? parts.slice(0, -1) : parts;
	const pretty = trimmed.join("-");
	return qualified && provider ? `${pretty} · ${provider}` : pretty;
}