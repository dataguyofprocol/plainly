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

export const ATTACHMENT_ACCEPT = ATTACHABLE_EXTENSIONS.join(",");

const IMAGE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp"]);
const MARKER = /^\[Attached file: (.+)\]$/;

export function attachmentName(path: string): string {
	return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

export function attachmentExtension(nameOrPath: string): string {
	const name = attachmentName(nameOrPath);
	const dot = name.lastIndexOf(".");
	return dot > 0 ? name.slice(dot).toLowerCase() : "";
}

export function isAttachable(nameOrPath: string): boolean {
	return (ATTACHABLE_EXTENSIONS as readonly string[]).includes(attachmentExtension(nameOrPath));
}

export function attachmentKind(path: string): "pdf" | "image" | "text" {
	const ext = attachmentExtension(path);
	if (ext === ".pdf") return "pdf";
	return IMAGE_EXTENSIONS.has(ext) ? "image" : "text";
}

export function attachmentRefusal(name: string): string {
	const ext = attachmentExtension(name);
	return ext ? `Plainly can't read ${ext} files yet.` : `Plainly can't read ${name} yet.`;
}

export function attachmentLine(path: string): string {
	return `[Attached file: ${path}]`;
}

export function withAttachments(text: string, paths: readonly string[]): string {
	const words = text.trim();
	if (paths.length === 0) return words;
	const lines = paths.map(attachmentLine).join("\n");
	return words ? `${words}\n\n${lines}` : lines;
}

/** Only the trailing run of marker lines counts as attachments. */
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
