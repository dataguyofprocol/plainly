export type ToolIcon = "sessions" | "ideas" | "file" | "folder" | "search";

export interface ToolHeadline {
	icon: ToolIcon;
	label: string;
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
