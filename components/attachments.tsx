"use client";

/**
 * ATTACHMENTS (owner, 2026-10-31) — the paperclip and the composer drop
 * target. Desktop only: a picked or dropped File becomes its absolute disk
 * path through the preload seam (window.lh.pathForFile), and the send
 * carries that path on a marker line (src/core/attachments.ts). Nothing is
 * read, copied, or uploaded here — the agent reads the file on its own
 * terms. Browser builds have no seam: no paperclip, drops are ignored.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Icon } from "@/components/ui/icon";
import {
	ATTACHMENT_ACCEPT,
	attachmentKind,
	attachmentName,
	attachmentRefusal,
	isAttachable,
} from "@/src/core";

const KIND_ICON = { pdf: "pdf", image: "figure", text: "file" } as const;

/** Picked/dropped files → the paths to add and the refusal lines. Pure:
 *  readable types only, disk-backed only, no duplicates. */
export function resolveAttachments(
	files: readonly { name: string }[],
	pathFor: (file: { name: string }) => string,
	existing: readonly string[],
): { paths: string[]; errors: string[] } {
	const paths: string[] = [];
	const errors: string[] = [];
	for (const file of files) {
		if (!isAttachable(file.name)) {
			errors.push(attachmentRefusal(file.name));
			continue;
		}
		const path = pathFor(file);
		if (!path) {
			errors.push(`${file.name} isn't a file on disk, so it can't be attached.`);
			continue;
		}
		if (!existing.includes(path) && !paths.includes(path)) paths.push(path);
	}
	return { paths, errors: [...new Set(errors)] };
}

/** Whether this shell can attach (the desktop preload's path seam).
 *  Post-mount only — server HTML and the first client render agree. */
export function useCanAttach(): boolean {
	const [can, setCan] = useState(false);
	useEffect(() => setCan(typeof window.lh?.pathForFile === "function"), []);
	return can;
}

/** The composer's pending attachments. `current()` reads the ref mirror so
 *  a send resuming after `await dictation.finish()` sees the live list. */
export function useAttachments() {
	const [paths, setPaths] = useState<string[]>([]);
	const [errors, setErrors] = useState<string[]>([]);
	const ref = useRef<string[]>([]);
	const commit = useCallback((next: string[]) => {
		ref.current = next;
		setPaths(next);
	}, []);
	const add = useCallback(
		(files: readonly File[]) => {
			const pathFor = window.lh?.pathForFile;
			if (!pathFor || files.length === 0) return;
			const result = resolveAttachments(files, (f) => pathFor(f as File), ref.current);
			setErrors(result.errors);
			if (result.paths.length > 0) commit([...ref.current, ...result.paths]);
		},
		[commit],
	);
	const remove = useCallback((path: string) => commit(ref.current.filter((p) => p !== path)), [commit]);
	const clear = useCallback(() => {
		commit([]);
		setErrors([]);
	}, [commit]);
	/** Put a refused send's files back (the draft-restore seam). */
	const restore = useCallback((next: readonly string[]) => commit([...next]), [commit]);
	const current = useCallback(() => ref.current, []);
	return { paths, errors, add, remove, clear, restore, current };
}

/** The hidden file input behind a paperclip button. */
export function useFilePicker(onFiles: (files: File[]) => void) {
	const ref = useRef<HTMLInputElement>(null);
	const input = (
		<input
			ref={ref}
			type="file"
			multiple
			hidden
			accept={ATTACHMENT_ACCEPT}
			data-testid="attach-input"
			onChange={(e) => {
				onFiles(Array.from(e.target.files ?? []));
				e.target.value = ""; // picking the same file again still fires
			}}
		/>
	);
	return { input, open: () => ref.current?.click() };
}

const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

/** Drop handlers for a composer surface; `dropping` outlines it. Disabled
 *  (browser builds), a drag passes through to the shell's stray-drop guard. */
export function useFileDrop(onFiles: ((files: File[]) => void) | undefined) {
	const [dropping, setDropping] = useState(false);
	const handlers = {
		onDragOver: (e: React.DragEvent) => {
			if (!onFiles || !carriesFiles(e)) return;
			e.preventDefault();
			e.dataTransfer.dropEffect = "copy";
			setDropping(true);
		},
		onDragLeave: (e: React.DragEvent) => {
			if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
			setDropping(false);
		},
		onDrop: (e: React.DragEvent) => {
			if (!onFiles || !carriesFiles(e)) return;
			e.preventDefault();
			setDropping(false);
			onFiles(Array.from(e.dataTransfer.files));
		},
	};
	return { dropping, handlers };
}

/** One chip per attached file: kind icon + file name, full path on hover.
 *  `onRemove` adds the × (the composer); the transcript's chips are static. */
export function AttachmentChips({ paths, onRemove }: { paths: readonly string[]; onRemove?: (path: string) => void }) {
	if (paths.length === 0) return null;
	return (
		<div className="att-chips" data-testid="attachment-chips">
			{paths.map((path) => {
				const name = attachmentName(path);
				return (
					<span key={path} className="att-chip" title={path}>
						<Icon name={KIND_ICON[attachmentKind(path)]} size="sm" />
						<span className="att-name">{name}</span>
						{onRemove && (
							<button type="button" className="att-x" aria-label={`Remove ${name}`} onClick={() => onRemove(path)}>
								<Icon name="close" size="xs" />
							</button>
						)}
					</span>
				);
			})}
		</div>
	);
}

export function AttachmentErrors({ errors }: { errors: readonly string[] }) {
	return (
		<>
			{errors.map((error) => (
				<p key={error} role="alert" className="ferror dict-err" data-testid="attachment-error">
					<Icon name="attach" size="sm" />
					<span>{error}</span>
				</p>
			))}
		</>
	);
}
