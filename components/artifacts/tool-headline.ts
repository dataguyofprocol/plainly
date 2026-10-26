/**
 * What a tool call DID, in the learner's words (v4 polish, 2026-10-26) —
 * the transcript shows "Looked through your sessions", not
 * "list_sessions ›". Pure: tool name + input → a short past-tense
 * sentence and the icon that goes with it; unknown tools fall back to
 * their name, humanised.
 */

export type ToolIcon = "sessions" | "ideas" | "file" | "folder" | "search";

export interface ToolHeadline {
	icon: ToolIcon;
	/** Past tense, sentence case, no trailing period. */
	label: string;
	/** The call's subject (a path, a pattern), shown quietly after the label. */
	detail: string | null;
}

export function toolHeadline(tool: string, input: unknown): ToolHeadline {
	const inp = (input ?? {}) as Record<string, unknown>;
	const str = (k: string) => (typeof inp[k] === "string" && (inp[k] as string).length > 0 ? (inp[k] as string) : null);
	switch (tool) {
		case "list_sessions":
			return { icon: "sessions", label: "Looked through your past sessions", detail: null };
		case "list_propositions":
			return { icon: "ideas", label: "Read the ideas from a past session", detail: null };
		case "read":
			return { icon: "file", label: "Read a file", detail: str("path") };
		case "ls":
			return { icon: "folder", label: "Listed a folder", detail: str("path") ?? "~" };
		case "find":
			return { icon: "search", label: "Searched for files", detail: str("pattern") };
		case "grep":
			return { icon: "search", label: "Searched inside files", detail: str("pattern") };
		default: {
			const words = tool.replace(/[_-]+/g, " ").trim();
			return { icon: "search", label: words.charAt(0).toUpperCase() + words.slice(1), detail: null };
		}
	}
}
