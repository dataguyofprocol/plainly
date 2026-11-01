import { decodeOverescapedNewlines } from "./math-delims.ts";

type PropSchema = {
	type?: string;
	const?: unknown;
	anyOf?: PropSchema[];
};

function literalsOf(prop: PropSchema): unknown[] {
	if (prop.anyOf) return prop.anyOf.flatMap((m) => literalsOf(m));
	return "const" in prop ? [prop.const] : [];
}

function acceptsNull(prop: PropSchema): boolean {
	if (prop.type === "null") return true;
	return (prop.anyOf ?? []).some((m) => m.type === "null");
}

function tryParse(raw: string): unknown {
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return undefined;
	}
}

/**
 * A string where the schema expects a literal union, boolean, null, number,
 * or array is JSON-parsed and kept when the parsed value fits. Untouched args
 * return the same reference; unhealable values are left for validation.
 */
export function healEncodedArguments(
	args: unknown,
	schema: { properties?: Record<string, PropSchema> },
): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	const properties = schema.properties;
	if (!properties) return args;
	let healed: Record<string, unknown> | null = null;
	for (const [key, prop] of Object.entries(properties)) {
		const raw = (args as Record<string, unknown>)[key];
		if (typeof raw !== "string") continue;
		const parsed = tryParse(raw);
		let fixed: unknown;
		const literals = literalsOf(prop);
		if (literals.length > 0) {
			if (literals.includes(raw)) continue;
			if (literals.includes(parsed)) fixed = parsed;
		}
		// TypeBox's Type.Null carries no const, so the literal branch misses null.
		if (fixed === undefined && acceptsNull(prop) && parsed === null) fixed = null;
		if (fixed === undefined && prop.type === "boolean" && typeof parsed === "boolean") {
			fixed = parsed;
		}
		if (
			fixed === undefined &&
			(prop.type === "number" || prop.type === "integer") &&
			typeof parsed === "number"
		) {
			fixed = parsed;
		}
		if (fixed === undefined && prop.type === "array" && Array.isArray(parsed)) fixed = parsed;
		if (fixed !== undefined) {
			healed ??= { ...(args as Record<string, unknown>) };
			healed[key] = fixed;
		}
	}
	return healed ?? args;
}

/**
 * A field is a top-level key (`"question"`) or a key inside every object of
 * an array field (`"options[].description"`). Untouched args return the same
 * reference; idempotent.
 */
export function healProseEscapes(args: unknown, fields: readonly string[]): unknown {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return args;
	let healed: Record<string, unknown> | null = null;
	for (const field of fields) {
		const [key, inner] = field.split("[].") as [string, string | undefined];
		const raw = (args as Record<string, unknown>)[key];
		let fixed: unknown = raw;
		if (inner === undefined) {
			if (typeof raw === "string") fixed = decodeOverescapedNewlines(raw);
		} else if (Array.isArray(raw)) {
			let items: unknown[] | null = null;
			raw.forEach((item, i) => {
				if (typeof item !== "object" || item === null) return;
				const value = (item as Record<string, unknown>)[inner];
				if (typeof value !== "string") return;
				const decoded = decodeOverescapedNewlines(value);
				if (decoded === value) return;
				items ??= [...raw];
				items[i] = { ...(items[i] as Record<string, unknown>), [inner]: decoded };
			});
			if (items) fixed = items;
		}
		if (fixed !== raw) {
			healed ??= { ...(args as Record<string, unknown>) };
			healed[key] = fixed;
		}
	}
	return healed ?? args;
}
