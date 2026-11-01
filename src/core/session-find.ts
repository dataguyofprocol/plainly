export interface SessionTextMatch {
	start: number;
	end: number;
}

export function findSessionTextMatches(text: string, query: string): SessionTextMatch[] {
	if (!query) return [];
	// RegExp offsets index the original UTF-16 string; lowercasing first can change its length (İ).
	const literal = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	const pattern = new RegExp(literal, "giu");
	return Array.from(text.matchAll(pattern), (m) => ({ start: m.index, end: m.index + m[0].length }));
}

export function stepSessionMatch(index: number, count: number, direction: 1 | -1): number {
	if (!count) return -1;
	return ((index + direction) % count + count) % count;
}
