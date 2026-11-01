export const FRAGMENT_RE = /^\d+-[\w.-]+\.md$/;

export type PromptAgent = "prober" | "teacher" | "practice";

export interface PromptSegmentInfo {
	/** Mirrors the source layout, e.g. "shared/05-learner-files.md". */
	path: string;
	sourceText: string;
	/** Null when no override file exists. */
	overrideText: string | null;
	/** The settings switch is on AND the override file exists. */
	enabled: boolean;
	/** True for the base and shared/ fragments, which both agents compose. */
	shared: boolean;
}

export function isValidSegmentPath(segmentPath: string): boolean {
	if (segmentPath === "system-prompt.md") return true;
	const m = /^(prober|teacher|practice|shared)\/([\w.-]+\.md)$/.exec(segmentPath);
	if (!m || m[2] === undefined) return false;
	return FRAGMENT_RE.test(m[2]);
}
