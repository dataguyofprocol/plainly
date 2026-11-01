"use client";

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

export function useCanAttach(): boolean {
	const [can, setCan] = useState(false);
	useEffect(() => setCan(typeof window.lh?.pathForFile === "function"), []);
	return can;
}

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
	const restore = useCallback((next: readonly string[]) => commit([...next]), [commit]);
	const current = useCallback(() => ref.current, []);
	return { paths, errors, add, remove, clear, restore, current };
}

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
				e.target.value = "";
			}}
		/>
	);
	return { input, open: () => ref.current?.click() };
}

const carriesFiles = (e: React.DragEvent) => Array.from(e.dataTransfer.types).includes("Files");

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
