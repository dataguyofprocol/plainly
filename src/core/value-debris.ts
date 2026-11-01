/** Strips surrounding whitespace, colons, dots, quotes, and backticks that
 * models copy onto membership values. Never apply to free text. */
export function stripModelValueDebris(value: string): string {
	return value.replace(/^[\s:."'`]+/, "").replace(/[\s:."'`]+$/, "");
}
