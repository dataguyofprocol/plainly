"use client";

/**
 * THE OMNIBAR (v4 redesign, owner 2026-10-26): ⌘K from anywhere — one
 * field that starts a lesson or a practice set, and finds sessions and
 * ideas. It replaced the sidebar's session search (⇧⌘F opens it too) and
 * took ⌘K from the model selector (now ⇧⌘M).
 *
 * The result model is a pure function (paletteResults) so the ranking and
 * grouping are pinned by tests; the component is the dialog around it.
 * Keyboard: ↑/↓ walk, Enter runs the walked row (the first row when
 * nothing is walked — the quick-open pattern the sidebar search had), Esc
 * closes. Esc is claimed at the document level like every surfaced layer
 * (THE ONE-ESC LAW in keyboard-shortcuts.tsx), so it never also aborts a
 * turn.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, DumbbellIcon, MessageSquareIcon, SettingsIcon, SparklesIcon, WaypointsIcon } from "lucide-react";
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useGraphIndex, type IndexedIdea } from "@/components/graph-index";
import { SetupDialog } from "@/components/setup-dialog";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { createSession, useStartReadiness } from "@/components/start-session";
import { cn } from "@/lib/utils";
import { fuzzyScore, kbdEventForAction, type ChatListItem } from "@/src/core";

export type PaletteMode = "teach" | "practice";

export type PaletteAction =
	| { kind: "start"; mode: PaletteMode; text: string }
	| { kind: "open-session"; id: string }
	| { kind: "open-idea"; id: string }
	| { kind: "route"; href: string }
	| { kind: "settings" };

export interface PaletteRow {
	key: string;
	label: string;
	hint: string;
	icon: "learn" | "practice" | "session" | "idea" | "graph" | "settings";
	action: PaletteAction;
}

export interface PaletteGroup {
	name: string;
	rows: PaletteRow[];
}

const SESSION_LIMIT = 5;
const IDEA_LIMIT = 5;

const COMMANDS: PaletteRow[] = [
	{ key: "cmd-graph", label: "Open the knowledge graph", hint: "⌘G", icon: "graph", action: { kind: "route", href: "/knowledge" } },
	{ key: "cmd-practice", label: "New practice set", hint: "mixed from your graph", icon: "practice", action: { kind: "route", href: "/chat/new?mode=practice" } },
	{ key: "cmd-settings", label: "Settings", hint: "models and keys", icon: "settings", action: { kind: "settings" } },
];

function isWaiting(c: ChatListItem): boolean {
	return c.pendingQuestion || ((c.kind ?? "teach") === "practice" && c.pendingProblem);
}

function sessionRow(c: ChatListItem): PaletteRow {
	const practice = (c.kind ?? "teach") === "practice";
	return {
		key: `s-${c.id}`,
		label: c.title,
		hint: isWaiting(c) ? "waiting on you" : practice ? "practice" : "lesson",
		icon: practice ? "practice" : "session",
		action: { kind: "open-session", id: c.id },
	};
}

function ranked<T>(items: readonly T[], query: string, fields: (t: T) => string[], limit: number): T[] {
	return items
		.map((item) => ({ item, score: fuzzyScore(query, ...fields(item)) }))
		.filter((r): r is { item: T; score: number } => r.score !== null)
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((r) => r.item);
}

/** Pure: what the omnibar lists for a query. Empty query = where you left
 *  off (waiting sessions first, then recent) plus the commands; a query =
 *  the two ways to start it (the chosen mode first), then matching
 *  sessions, ideas and commands. Exported for tests. */
export function paletteResults(
	query: string,
	mode: PaletteMode,
	chats: readonly ChatListItem[],
	ideas: readonly IndexedIdea[],
): PaletteGroup[] {
	const q = query.trim();
	if (!q) {
		return [
			{ name: "Waiting on you", rows: chats.filter(isWaiting).slice(0, SESSION_LIMIT).map(sessionRow) },
			{ name: "Recent", rows: chats.filter((c) => !isWaiting(c)).slice(0, SESSION_LIMIT).map(sessionRow) },
			{ name: "Commands", rows: COMMANDS },
		].filter((g) => g.rows.length > 0);
	}
	const learn: PaletteRow = { key: "start-teach", label: `Learn “${q}”`, hint: "new lesson", icon: "learn", action: { kind: "start", mode: "teach", text: q } };
	const practice: PaletteRow = { key: "start-practice", label: `Practice “${q}”`, hint: "new practice set", icon: "practice", action: { kind: "start", mode: "practice", text: q } };
	return [
		{ name: "Start", rows: mode === "teach" ? [learn, practice] : [practice, learn] },
		{ name: "Sessions", rows: ranked(chats, q, (c) => [c.title], SESSION_LIMIT).map(sessionRow) },
		{
			name: "Ideas you hold",
			rows: ranked(ideas, q, (i) => [i.name, i.statement], IDEA_LIMIT).map((i) => ({
				key: `i-${i.id}`,
				label: i.name,
				hint: i.source ?? "idea",
				icon: "idea" as const,
				action: { kind: "open-idea" as const, id: i.id },
			})),
		},
		{ name: "Commands", rows: ranked(COMMANDS, q, (c) => [c.label], COMMANDS.length) },
	].filter((g) => g.rows.length > 0);
}

const ICONS = {
	learn: SparklesIcon,
	practice: DumbbellIcon,
	session: MessageSquareIcon,
	idea: WaypointsIcon,
	graph: WaypointsIcon,
	settings: SettingsIcon,
} as const;

/** Mounted once in the AppShell; opens on ⌘K (open-omnibar) and ⇧⌘F
 *  (sessions-search). A start that isn't ready yet (no models, no key)
 *  opens setup instead — the pre-send guards — and the palette comes back
 *  with the learner's words still in it once setup is saved. */
export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [setupOpen, setSetupOpen] = useState(false);
	const [draft, setDraft] = useState<{ query: string; mode: PaletteMode }>({ query: "", mode: "teach" });
	const readiness = useStartReadiness();
	useEffect(() => {
		const onOpen = () => {
			setDraft({ query: "", mode: "teach" });
			setOpen(true);
		};
		const events = [kbdEventForAction("open-omnibar"), kbdEventForAction("sessions-search"), "lh:open-omnibar"];
		for (const e of events) window.addEventListener(e, onOpen);
		return () => {
			for (const e of events) window.removeEventListener(e, onOpen);
		};
	}, []);
	return (
		<>
			{open && (
				<PaletteDialog
					initial={draft}
					ready={readiness.ready}
					onClose={() => setOpen(false)}
					onNeedSetup={(next) => {
						setDraft(next);
						setOpen(false);
						setSetupOpen(true);
					}}
				/>
			)}
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					readiness.markConfigured();
					setSetupOpen(false);
					setOpen(true); // Save only saves: the words wait in the palette
				}}
			/>
		</>
	);
}

function PaletteDialog({
	initial,
	ready,
	onClose,
	onNeedSetup,
}: {
	initial: { query: string; mode: PaletteMode };
	ready: boolean;
	onClose: () => void;
	onNeedSetup: (draft: { query: string; mode: PaletteMode }) => void;
}) {
	const backdropDismiss = useBackdropDismiss(onClose);

	// The surfaced layer claims Esc at the document level (THE ONE-ESC LAW).
	useEffect(() => {
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key !== "Escape") return;
			e.stopPropagation();
			e.preventDefault();
			onClose();
		};
		document.addEventListener("keydown", onKeyDown);
		return () => document.removeEventListener("keydown", onKeyDown);
	}, [onClose]);

	return createPortal(
		<div
			data-testid="command-palette"
			className="fixed inset-0 z-50 flex items-start justify-center bg-foreground/10 px-4 pt-[14vh] backdrop-blur-[2px]"
			{...backdropDismiss}
		>
			<div
				role="dialog"
				aria-modal="true"
				aria-label="Search and start"
				className="settings-dialog-pop flex max-h-[70vh] w-full max-w-[40rem] flex-col overflow-hidden rounded-2xl border border-border bg-popover shadow-[0_24px_60px_var(--shadow)]"
			>
				<Omnibar variant="dialog" initial={initial} ready={ready} onDone={onClose} onNeedSetup={onNeedSetup} />
			</div>
		</div>,
		document.body,
	);
}

/**
 * The omnibar itself — the field, the Learn/Practice switch and the
 * grouped results. Two variants: "dialog" (⌘K, results always listed) and
 * "inline" (the home page: results drop down only once there is a query,
 * and Esc clears the field rather than closing anything).
 */
export function Omnibar({
	variant,
	initial = { query: "", mode: "teach" },
	ready,
	onDone,
	onNeedSetup,
	extraActions,
}: {
	variant: "dialog" | "inline";
	initial?: { query: string; mode: PaletteMode };
	ready: boolean;
	/** After a row ran (the dialog closes). */
	onDone?: () => void;
	onNeedSetup: (draft: { query: string; mode: PaletteMode }) => void;
	/** Inline only: controls beside the mode switch (the home's import). */
	extraActions?: React.ReactNode;
}) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const ideas = useGraphIndex();
	const [chats, setChats] = useState<ChatListItem[]>([]);
	const [query, setQuery] = useState(initial.query);
	const [mode, setMode] = useState<PaletteMode>(initial.mode);
	const [walk, setWalk] = useState(0);
	const [starting, setStarting] = useState(false);
	const [focused, setFocused] = useState(variant === "dialog");
	const inputRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLDivElement>(null);
	const inline = variant === "inline";

	useEffect(() => {
		if (!inline) inputRef.current?.focus();
		let alive = true;
		fetch("/api/chats", { cache: "no-store" })
			.then((r) => r.json())
			.then((d: { chats: ChatListItem[] }) => alive && setChats(d.chats))
			.catch(() => {});
		return () => {
			alive = false;
		};
	}, [inline]);

	const groups = useMemo(() => paletteResults(query, mode, chats, ideas ?? []), [query, mode, chats, ideas]);
	const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
	const active = Math.min(walk, Math.max(0, rows.length - 1));
	const showResults = !inline || (focused && query.trim().length > 0);

	useEffect(() => {
		listRef.current?.querySelector<HTMLElement>(`[data-row-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
	}, [active]);

	const run = useCallback(
		async (row: PaletteRow | undefined) => {
			if (!row || starting) return;
			const a = row.action;
			if (a.kind === "start") {
				if (!ready) {
					onNeedSetup({ query, mode });
					return;
				}
				setStarting(true);
				try {
					router.push(await createSession(a.text, a.mode));
					onDone?.();
				} catch {
					setStarting(false);
				}
				return;
			}
			onDone?.();
			if (a.kind === "open-session") router.push(`/chat/${a.id}`);
			else if (a.kind === "open-idea") router.push(`/knowledge?idea=${encodeURIComponent(a.id)}`);
			else if (a.kind === "route") router.push(a.href);
			else openSettings();
		},
		[mode, onDone, onNeedSetup, openSettings, query, ready, router, starting],
	);

	// The primary action without walking: start in the chosen mode.
	const submitLabel = mode === "teach" ? "Learn" : "Practice";
	const startNow = () => {
		const q = query.trim();
		if (!q) {
			inputRef.current?.focus();
			return;
		}
		void run({ key: "start", label: q, hint: "", icon: mode === "teach" ? "learn" : "practice", action: { kind: "start", mode, text: q } });
	};

	let index = -1;
	const results = (
		<div
			ref={listRef}
			className={cn("overflow-y-auto py-1.5", inline && "absolute inset-x-0 top-[calc(100%+6px)] z-20 max-h-[50vh] rounded-2xl border border-border bg-popover shadow-[0_20px_50px_var(--shadow)]")}
			role="listbox"
			aria-label="Results"
		>
			{groups.length === 0 && <p className="px-5 py-4 text-sm text-muted-foreground">Nothing yet.</p>}
			{groups.map((g) => (
				<div key={g.name} className="pb-1">
					<div className="px-5 pb-1 pt-2 text-xs font-semibold text-faint">{g.name}</div>
					{g.rows.map((row) => {
						index += 1;
						const i = index;
						const Icon = ICONS[row.icon];
						return (
							<button
								key={row.key}
								type="button"
								role="option"
								aria-selected={i === active}
								data-row-index={i}
								onMouseMove={() => setWalk(i)}
								// Keep focus in the field while clicking (the inline list
								// closes on blur).
								onMouseDown={(e) => e.preventDefault()}
								onClick={() => void run(row)}
								className={cn(
									"flex w-full items-center gap-3 px-5 py-2 text-left text-sm transition-colors",
									i === active ? "bg-accent text-foreground" : "text-foreground",
								)}
							>
								<Icon className={cn("size-4 shrink-0", row.icon === "learn" ? "text-brand" : "text-muted-foreground")} aria-hidden />
								<span className={cn("min-w-0 flex-1 truncate", row.icon === "idea" && "font-prose text-[15px]")}>{row.label}</span>
								<span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground">{row.hint}</span>
								{i === active && <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
							</button>
						);
					})}
				</div>
			))}
		</div>
	);

	const modeSwitch = (
		<div role="radiogroup" aria-label="Start as" className="flex rounded-lg bg-muted p-0.5">
			{(["teach", "practice"] as const).map((m) => (
				<button
					key={m}
					type="button"
					role="radio"
					aria-checked={mode === m}
					data-testid={`omnibar-mode-${m}`}
					onClick={() => {
						setMode(m);
						inputRef.current?.focus();
					}}
					className={cn(
						"h-7 rounded-md px-3 text-sm font-medium transition-colors",
						mode === m ? "bg-popover font-semibold text-foreground shadow-[0_1px_2px_var(--shadow)]" : "text-muted-foreground hover:text-foreground",
					)}
				>
					{m === "teach" ? "Learn" : "Practice"}
				</button>
			))}
		</div>
	);

	return (
		<div className={cn(inline && "relative")}>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					startNow();
				}}
				className={cn(
					"flex flex-col gap-2",
					inline
						? "rounded-2xl border border-border bg-popover px-5 pb-2.5 pt-1.5 shadow-[0_10px_30px_var(--shadow)] transition-shadow focus-within:border-brand focus-within:shadow-[0_0_0_1px_var(--brand),0_14px_40px_var(--shadow)]"
						: "border-b border-border px-5 pb-3 pt-2",
				)}
			>
				<input
					ref={inputRef}
					value={query}
					onChange={(e) => {
						setQuery(e.target.value);
						setWalk(0);
					}}
					onFocus={() => setFocused(true)}
					onBlur={() => inline && setFocused(false)}
					onKeyDown={(e) => {
						if (e.key === "ArrowDown" || e.key === "ArrowUp") {
							if (!showResults) return;
							e.preventDefault();
							const n = rows.length;
							if (n) setWalk((i) => (Math.min(i, n - 1) + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
						} else if (e.key === "Enter") {
							e.preventDefault();
							if (showResults) void run(rows[active]);
							else startNow();
						} else if (e.key === "Escape" && inline) {
							// A field-level claim: clear, then leave the field.
							e.stopPropagation();
							if (query) setQuery("");
							else e.currentTarget.blur();
						}
					}}
					placeholder={mode === "teach" ? "Learn anything, or search your sessions and ideas…" : "Practice a topic, or search your sessions and ideas…"}
					aria-label="Learn, practice or search"
					data-testid={inline ? "home-omnibar" : undefined}
					spellCheck={false}
					autoComplete="off"
					className="h-13 w-full border-0 bg-transparent font-prose text-[19px] text-foreground outline-none placeholder:text-faint"
				/>
				<div className="flex items-center gap-2">
					{modeSwitch}
					{extraActions}
					{inline ? (
						<>
							<span className="ml-auto hidden text-xs text-faint sm:inline">
								<kbd className="rounded border border-border px-1 font-mono">⌘K</kbd> from anywhere
							</span>
							<button
								type="submit"
								disabled={starting}
								className="ml-2 flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
							>
								{submitLabel} <ArrowRightIcon className="size-4" aria-hidden />
							</button>
						</>
					) : (
						<span className="ml-auto text-xs text-faint">↑↓ to move · ↵ to open · esc to close</span>
					)}
				</div>
			</form>
			{showResults && results}
		</div>
	);
}
