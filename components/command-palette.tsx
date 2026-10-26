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
import { useBackdropDismiss } from "@/components/backdrop-dismiss";
import { useGraphIndex, type IndexedIdea } from "@/components/graph-index";
import { SetupDialog } from "@/components/setup-dialog";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { OPEN_CONNECT_EVENT } from "@/components/connect-provider";
import { createSession, useStartReadiness } from "@/components/start-session";
import { cn } from "@/lib/utils";
import { Icon, type IconName } from "@/components/ui/icon";
import { displayTitle, displayTopic } from "@/components/ui/format";
import { EmptyState } from "@/components/ui/empty-state";
import { bindingParts } from "@/components/settings/keyboard-section";
import { fuzzyScore, kbdEventForAction, type ChatListItem } from "@/src/core";

export type PaletteMode = "teach" | "practice";

export type PaletteAction =
	| { kind: "start"; mode: PaletteMode; text: string }
	| { kind: "open-session"; id: string }
	| { kind: "open-idea"; id: string }
	| { kind: "route"; href: string }
	| { kind: "settings" }
	| { kind: "connect" };

export interface PaletteRow {
	key: string;
	label: string;
	hint: string;
	icon: "learn" | "practice" | "session" | "idea" | "graph" | "settings" | "connect";
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
	{ key: "cmd-connect", label: "Connect a provider", hint: "API keys and endpoints", icon: "connect", action: { kind: "connect" } },
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

/** Each row kind's glyph — the app's semantic icon names (Practice is
 *  always a target, Knowledge always a network). */
const ROW_ICON: Record<PaletteRow["icon"], IconName> = {
	learn: "learn",
	practice: "practice",
	session: "lesson",
	idea: "idea",
	graph: "knowledge",
	settings: "settings",
	connect: "provider",
};

/** Display-only: titles and hints in sentence case; a session that waits
 *  on you gets the warn pill; a shortcut renders as key chips. */
function RowHint({ row, group }: { row: PaletteRow; group: string }) {
	if (row.hint === "waiting on you") {
		// Under its own "Waiting on you" overline the pill would repeat it.
		return group === "Waiting on you" ? <span className="dot warn" aria-hidden /> : <span className="pill warn">Waiting on you</span>;
	}
	if (/^[⌘⇧⌥⌃]/.test(row.hint)) {
		return (
			<span className="keys" aria-label={row.hint}>
				{bindingParts(row.hint).map((k, i) => (
					<kbd key={i} className="kbd">
						{k}
					</kbd>
				))}
			</span>
		);
	}
	const text = row.icon === "idea" ? displayTopic(row.hint) : row.hint.charAt(0).toUpperCase() + row.hint.slice(1);
	return <span className="pal-hint">{text}</span>;
}

function rowLabel(row: PaletteRow): string {
	return row.action.kind === "open-session" ? displayTitle(row.label) : row.label;
}

/** Mounted once in the AppShell; opens on ⌘K (open-omnibar) and ⇧⌘F
 *  (sessions-search). A start that isn't ready yet (no models, no key)
 *  opens setup instead — the pre-send guards — and the palette comes back
 *  with the learner's words still in it once setup is saved. */
export function CommandPalette() {
	const [open, setOpen] = useState(false);
	const [setupOpen, setSetupOpen] = useState(false);
	// Opened through lh:open-connect: setup starts on the connect screen
	// even when a provider is already keyed.
	const [connect, setConnect] = useState(false);
	const [draft, setDraft] = useState<{ query: string; mode: PaletteMode }>({ query: "", mode: "teach" });
	const readiness = useStartReadiness();
	useEffect(() => {
		// lh:open-omnibar may carry a starting query (the graph card's
		// "Go deeper" opens the omnibar on the idea's name).
		const onOpen = (e: Event) => {
			const query = (e as CustomEvent<{ query?: string } | undefined>).detail?.query ?? "";
			setDraft({ query, mode: "teach" });
			setOpen(true);
		};
		const onConnect = () => {
			setConnect(true);
			setSetupOpen(true);
		};
		const events = [kbdEventForAction("open-omnibar"), kbdEventForAction("sessions-search"), "lh:open-omnibar"];
		for (const e of events) window.addEventListener(e, onOpen);
		window.addEventListener(OPEN_CONNECT_EVENT, onConnect);
		return () => {
			for (const e of events) window.removeEventListener(e, onOpen);
			window.removeEventListener(OPEN_CONNECT_EVENT, onConnect);
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
						setConnect(false);
						setSetupOpen(true);
					}}
				/>
			)}
			<SetupDialog
				open={setupOpen}
				connect={connect}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					readiness.markConfigured();
					setSetupOpen(false);
					if (!connect) setOpen(true); // Save only saves: the words wait in the palette
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
		<div className="v4 scope">
			<div data-testid="command-palette" className="overlay high" {...backdropDismiss}>
				<div role="dialog" aria-modal="true" aria-label="Search and start" className="dialog pal">
					<Omnibar variant="dialog" initial={initial} ready={ready} onDone={onClose} onNeedSetup={onNeedSetup} />
				</div>
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
			else if (a.kind === "connect") window.dispatchEvent(new Event(OPEN_CONNECT_EVENT));
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
			className={cn("pal-list", inline && "pop pal-drop")}
			role="listbox"
			aria-label="Results"
		>
			{groups.length === 0 && (
				<EmptyState icon="search" title="Nothing yet" className="pal-empty">
					Type a topic to start a lesson, or a word to find a session.
				</EmptyState>
			)}
			{groups.map((g) => (
				<div key={g.name} className="pal-group" role="group" aria-label={g.name}>
					<span className="over">{g.name}</span>
					{g.rows.map((row) => {
						index += 1;
						const i = index;
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
								className="pal-row"
							>
								<span className={cn("pal-ic", (row.icon === "learn" || row.icon === "practice") && row.icon)}>
									<Icon name={ROW_ICON[row.icon]} size="sm" />
								</span>
								<span className={cn("pal-label", row.icon === "idea" && "is-idea")}>{rowLabel(row)}</span>
								<RowHint row={row} group={g.name} />
								<Icon name="enter" size="sm" className="pal-go" />
							</button>
						);
					})}
				</div>
			))}
		</div>
	);

	const modeSwitch = (
		<div role="radiogroup" aria-label="Start as" className="seg sm">
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
					className={mode === m ? "on" : undefined}
				>
					<Icon name={m === "teach" ? "learn" : "practice"} size="xs" />
					{m === "teach" ? "Learn" : "Practice"}
				</button>
			))}
		</div>
	);

	return (
		<div className={cn(inline ? "pal-inline" : "pal-body")}>
			<form
				onSubmit={(e) => {
					e.preventDefault();
					startNow();
				}}
				className={cn("pal-field", inline && "glass")}
			>
				<Icon name="search" size="md" />
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
					className="pal-input"
				/>
				{modeSwitch}
				{extraActions}
				{inline && (
					<button type="submit" disabled={starting} className="btn">
						{submitLabel}
						<Icon name="arrow-right" size="sm" />
					</button>
				)}
			</form>
			{showResults && results}
			{!inline && (
				<div className="pal-foot" aria-hidden>
					<span>
						<kbd className="kbd">↑</kbd>
						<kbd className="kbd">↓</kbd>
						to move
					</span>
					<span>
						<kbd className="kbd">↵</kbd>
						to open
					</span>
					<span>
						<kbd className="kbd">esc</kbd>
						to close
					</span>
					{starting && (
						<span className="pal-starting">
							<span className="wave"><i /><i /><i /><i /></span>
							Starting…
						</span>
					)}
				</div>
			)}
		</div>
	);
}
