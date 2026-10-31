/**
 * ATTACHMENTS (owner, 2026-10-31) — the composer's paperclip and drop
 * target, kept to what the agent can already read. Attaching is a
 * REFERENCE, never an upload: a file keeps living where it is, and the
 * message carries its absolute path on a marker line the agent reads like
 * any path the learner typed (read / pdf job, on its own terms — the
 * 2026-09-19 "nothing auto-injects" rule stands).
 *
 * The wire format is the message text itself (no schema change): the
 * learner's words, a blank line, then one marker line per file. Only the
 * TRAILING run of marker lines counts as attachments, so a marker typed
 * mid-message stays prose.
 */

/** What the agent can read today: text, the read tool's image types, PDF. */
export const ATTACHABLE_EXTENSIONS = [
	".md",
	".markdown",
	".txt",
	".jpg",
	".jpeg",
	".png",
	".gif",
	".webp",
	".bmp",
	".pdf",
] as const;

/** The file picker's `accept` attribute. */
export const ATTACHMENT_ACCEPT = ATTACHABLE_EXTENSIONS.join(",");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const MARKER = /^\[Attached file: (.+)\]$/;

/** The last path segment (either separator — Windows paths too). */
export function attachmentName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Lowercased ".ext" of a file name or path; "" without one. */
export function attachmentExtension(nameOrPath: string): string {
	const name = attachmentName(nameOrPath);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function isAttachable(nameOrPath: string): boolean {
	return (ATTACHABLE_EXTENSIONS as readonly string[]).includes(attachmentExtension(nameOrPath));
}

/** The chip's icon family. */
export function attachmentKind(path: string): "pdf" | "image" | "text" {
	const ext = attachmentExtension(path);
	if (ext === ".pdf") return "pdf";
	return IMAGE_EXTENSIONS.has(ext) ? "image" : "text";
}

/** The inline line for a refused file. */
export function attachmentRefusal(name: string): string {
	const ext = attachmentExtension(name);
	return ext ? `Plainly can't read ${ext} files yet.` : `Plainly can't read ${name} yet.`;
}

export function attachmentLine(path: string): string {
	return `[Attached file: ${path}]`;
}

/** The message text a send carries: the words, then one marker per file. */
export function withAttachments(text: string, paths: readonly string[]): string {
	const words = text.trim();
	if (paths.length === 0) return words;
	const lines = paths.map(attachmentLine).join("\n");
	return words ? `${words}\n\n${lines}` : lines;
}

/** Split a message back into the learner's words and the attached paths. */
export function splitAttachments(content: string): { text: string; paths: string[] } {
	const lines = content.split("\n");
	const paths: string[] = [];
	let end = lines.length;
	while (end > 0) {
		const match = MARKER.exec(lines[end - 1]!.trim());
		if (!match) break;
		paths.unshift(match[1]!);
		end -= 1;
	}
	if (paths.length === 0) return { text: content, paths };
	return { text: lines.slice(0, end).join("\n").trimEnd(), paths };
}
