"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { MenuShell } from "@/components/menu-shell";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import type { ChatDeleteMode } from "@/src/core";
import {
	ActivityIcon,
	DumbbellIcon,
	HouseIcon,
	ListIcon,
	PanelLeftCloseIcon,
	PanelLeftOpenIcon,
	PlusIcon,
	SearchIcon,
	SettingsIcon,
	WaypointsIcon,
} from "lucide-react";
import { ActivitySection, toBlobs, useActivity } from "@/components/activity-dock";
import { CommandPalette } from "@/components/command-palette";
import { useGraphIndex } from "@/components/graph-index";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { LhMark } from "@/components/lh-mark";
import { BrailleSpinner } from "@/components/braille-spinner";
import { KeyboardShortcuts } from "@/components/keyboard-shortcuts";
import { SettingsDialogProvider, useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { Hint } from "@/components/ui/hint";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useServerEvent, useServerResync } from "@/components/server-events";
import type { ChatListItem } from "@/src/core";
import { kbdEventForAction } from "@/src/core";
import { notifySettingsSaved } from "@/components/settings-signal";

/**
 * The app sidebar (v4 redesign, owner 2026-10-26) — NOT a modal drawer: no
 * backdrop, no focus theft. Two widths, never hidden: EXPANDED (240px —
 * nav, sessions grouped by what they need from you, background agents,
 * settings) and the RAIL (72px — the same destinations as icons). The rail
 * is always there, so the traffic lights always sit over the sidebar and
 * no page header carries a reopen toggle any more.
 *
 * The preference is per KIND of page: lessons and practice sessions
 * default to the rail (the reading column gets the room), every other
 * page defaults to expanded. ⌘B flips the preference for the kind you are
 * on; both persist in localStorage.
 */

const STORAGE_KEY = "lh:sidebar-open";
const SESSION_STORAGE_KEY = "lh:sidebar-open-session";

/** Session pages (a lesson, a practice set, a draft) default to the rail. */
export function isSessionPath(pathname: string | null): boolean {
	return pathname !== null && pathname.startsWith("/chat/");
}

/*
 * Narrow-window behavior (owner, 2026-09-17): below SIDEBAR_AUTOCLOSE the
 * expanded sidebar would squeeze the page below its 640px floor (the two
 * numbers compose: 640 + 240 sidebar = 880), so it collapses to the rail —
 * and auto-RESTORES when the window widens again (owner choice: the sidebar
 * pops back, not a manual re-open). The whole behavior is one expression:
 * rendered = pref && !narrow, where pref is the persisted user choice.
 * Manual closes persist and stay closed; auto-close does not touch the
 * preference. Opening the sidebar while narrow asks the Electron shell to
 * widen the window to the threshold (window.lh.expandWindow, IPC in
 * electron/main.cjs) — the resize listener flips `narrow` and the sidebar
 * appears. In the plain browser there is no window to widen and no
 * suppression — a narrow tab opens the sidebar if the user says so.
 *
 * Mirrors SIDEBAR_AUTOCLOSE in electron/main.cjs — keep in sync.
 */
import type { ChatGPTControlBridge, NativeSubscriptionControlBridge } from "@/src/core";
const SIDEBAR_AUTOCLOSE = 880;

// Module scope, guarded for SSR (the server has no navigator).
const IS_ELECTRON = typeof navigator !== "undefined" && navigator.userAgent.includes("Electron");

declare global {
	interface Window {
		/** Preload bridge (electron/preload.cjs) — Electron only, absent in the browser. */
		lh?: {
			/** Read-only host OS; determines the native-control gutter. */
			platform?: string;
			chatgpt?: ChatGPTControlBridge;
			subscriptions?: NativeSubscriptionControlBridge;
			expandWindow: () => void;
			/** The zoom truth (owner round 7): subscribes to "lh:zoom" pushes; returns unsubscribe. */
			onZoom?: (cb: (factor: number) => void) => () => void;
			getZoom?: () => Promise<number>;
			/** Auto-update channel (Wave C, 2026-10-10): "lh:update-status" pushes once a staged update exists. */
			onUpdateStatus?: (cb: (status: { status: string; version: string | null }) => void) => () => void;
			installUpdate?: () => void;
		};
	}
}

const SidebarContext = createContext<{ open: boolean; toggle: () => void }>({
	open: false,
	toggle: () => {},
});

export function useSidebar() {
	return useContext(SidebarContext);
}

export function SidebarProvider({ children }: { children: React.ReactNode }) {
	useEffect(() => {
		const bridge = window.lh?.chatgpt;
		if (!bridge) return;
		const off = bridge.onChange(() => notifySettingsSaved("keys"));
		notifySettingsSaved("keys"); // cover changes missed before this root-lifetime subscription
		return off;
	}, []);
	// Start on the rail so server and client first-render agree (no
	// hydration mismatch); the stored preferences are applied after mount.
	const pathname = usePathname();
	const inSession = isSessionPath(pathname);
	const [pagePref, setPagePref] = useState(false);
	const [sessionPref, setSessionPref] = useState(false);
	const open = inSession ? sessionPref : pagePref;
	const [narrow, setNarrow] = useState(false);
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		// Electron shell detection (merged chrome, 2026-09-17): keys the
		// .lh-electron CSS (app/globals.css) that turns the header bands
		// into the window's drag surface. Post-mount only — server HTML
		// and first client render must agree (no hydration mismatch),
		// and in the plain browser the class never appears.
		if (IS_ELECTRON) {
			document.documentElement.classList.add("lh-electron");
			document.documentElement.dataset.lhPlatform = window.lh?.platform ?? "";
		}

		// THE ZOOM TRUTH (owner round 7, 2026-10-05): ⌘±/⌘0 zoom the UI
		// (Electron zoomFactor) while the native traffic lights stay
		// physical-fixed — the CSS gutter lengths divide by this factor so
		// their RENDERED size never moves. getZoom covers the first-paint
		// race; every later change arrives as an lh:zoom push.
		const setZoomVar = (factor: number) =>
			document.documentElement.style.setProperty("--lh-zoom", String(factor));
		const off = window.lh?.onZoom?.(setZoomVar);
		void window.lh?.getZoom?.().then(setZoomVar);

		// Defaults: pages expanded (first run introduces the sidebar),
		// sessions on the rail.
		const stored = localStorage.getItem(STORAGE_KEY);
		setPagePref(stored === null ? true : stored === "1");
		setSessionPref(localStorage.getItem(SESSION_STORAGE_KEY) === "1");
		setMounted(true);
		return () => off?.();
	}, []);

	// Narrow-window auto-close/auto-restore (see SIDEBAR_AUTOCLOSE note):
	// fires only on actual resizes — a boolean compare, no layout work.
	// Both this and the mount effect land before the first paint, so a
	// narrow window never flashes the open sidebar on load.
	useEffect(() => {
		if (!IS_ELECTRON) return; // plain-browser tabs open freely
		const onResize = () => setNarrow(window.innerWidth < SIDEBAR_AUTOCLOSE);
		onResize();
		window.addEventListener("resize", onResize);
		return () => window.removeEventListener("resize", onResize);
	}, []);

	const toggle = useCallback(() => {
		const key = inSession ? SESSION_STORAGE_KEY : STORAGE_KEY;
		const set = inSession ? setSessionPref : setPagePref;
		// Expanding while narrow (auto-collapsed, or the user's own
		// collapsed-at-narrow): ask the shell to widen to the threshold —
		// the resize listener flips `narrow` and the sidebar expands. The
		// preference persists like any other expand, so a restart at a
		// narrow width still auto-restores when widened.
		if (narrow && !open) {
			localStorage.setItem(key, "1");
			set(true);
			window.lh?.expandWindow();
			return;
		}
		localStorage.setItem(key, open ? "0" : "1");
		set(!open);
	}, [inSession, narrow, open]);

	// ⌘B: the global shortcut dispatches kbdEventForAction("toggle-sidebar")
	// and the context answers on exactly that name — the shared spelling
	// is the fix for the interlude bug (the listener sat on the pre-
	// convention name "lh:toggle-sidebar" while the dispatcher sent
	// "lh:kbd-toggle-sidebar", so ⌘B silently did nothing; owner
	// 2026-09-25).
	useEffect(() => {
		const event = kbdEventForAction("toggle-sidebar");
		const onToggle = () => toggle();
		window.addEventListener(event, onToggle);
		return () => window.removeEventListener(event, onToggle);
	}, [toggle]);

	return (
		<SidebarContext.Provider value={{ open: open && !narrow, toggle }}>
			{/* transitions gated on mount: no slide-in flash on page load */}
			<div className={cn("flex h-dvh", mounted && "[&_.sidebar-motion]:transition-[width,margin,opacity]")}>{children}</div>
		</SidebarContext.Provider>
	);
}

/**
 * The row's status indicator (owner, minimal-color round): the braille
 * spinner, ONLY while a teach turn is in flight — monochrome motion, the
 * terminal's own glyph, existing exactly as long as the work does and
 * vanishing the moment it ends. Every other state renders NOTHING:
 * phases only advance (all sessions end in Teaching — phase-as-signal was
 * decoration, now retired app-wide), and question-pending is the dominant
 * RESTING state of real sessions — a resting state has no scan value, so
 * the meta line's "Waiting for input" text carries it. Idle is the
 * absence of a signal, by design.
 */
function SessionStatus({ busy }: { busy: boolean }) {
	if (!busy) return null;
	return <BrailleSpinner />;
}

/** Compact "how long ago": "just now", "5m ago", "3h ago", "2d ago",
 *  then a plain date. How long a session has been WAITING matters more
 *  than an absolute timestamp. Beyond a week the date renders ISO
 *  (YYYY-MM-DD, zero-padded) — the international standard: unambiguous
 *  in any locale and it sorts (owner, typography round 5; the old
 *  M/D/YYYY was the US convention. A user-locale setting can come later
 *  — trivial, a format function swap). Pure — exported for tests. */
export function timeAgo(iso: string, now = new Date()): string {
	const ms = now.getTime() - new Date(iso).getTime();
	if (ms < 60_000) return "just now";
	const min = Math.floor(ms / 60_000);
	if (min < 60) return `${min}m ago`;
	const h = Math.floor(min / 60);
	if (h < 24) return `${h}h ago`;
	const d = Math.floor(h / 24);
	if (d < 7) return `${d}d ago`;
	const date = new Date(iso);
	const mm = String(date.getMonth() + 1).padStart(2, "0");
	const dd = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${mm}-${dd}`;
}

/** The row's second line: the state when a state exists (waiting/working),
 *  otherwise just how long ago. The message count is DROPPED (owner,
 *  typography round 5): it informed no decision — clutter. messageCount
 *  still rides the API payload, so this is a one-line flip back if it's
 *  ever wanted. */
function sessionMeta(chat: ChatListItem): string {
	if (chat.compacting) return `Compacting context · ${timeAgo(chat.updatedAt)}`;
	if (chat.pendingQuestion) return `Waiting for input · ${timeAgo(chat.updatedAt)}`;
	if ((chat.kind ?? "teach") === "practice" && chat.pendingProblem) {
		return `Problem waiting · ${timeAgo(chat.updatedAt)}`;
	}
	if (chat.busy) return "Working…";
	return timeAgo(chat.updatedAt);
}

/**
 * One session row: the status spinner (only while working), then title +
 * state-aware meta. Exported for render tests — pure function of the
 * list item.
 */
export function SessionRow({
	chat,
	active,
	onOpen,
	kbdSelected = false,
	onContextMenu,
}: {
	chat: ChatListItem;
	active: boolean;
	onOpen: () => void;
	/** Keyboard-cycle highlight (shortcut wave A: Alt+↑/↓ + Alt+Enter) —
	 *  visually distinct from the active session, which stays filled. */
	kbdSelected?: boolean;
	/** Right-click opens the context menu (wave 6: Rename / Delete). */
	onContextMenu?: (e: React.MouseEvent<HTMLButtonElement>) => void;
}) {
	return (
		<button
			type="button"
			onClick={onOpen}
			onContextMenu={onContextMenu}
			data-testid={kbdSelected ? "session-row-kbd" : "session-row"}
			className={cn(
				"relative flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left transition-colors hover:bg-accent",
				active && "bg-popover shadow-[0_1px_2px_var(--shadow)] hover:bg-popover",
				kbdSelected && !active && "bg-accent/60 ring-1 ring-border",
			)}
		>
			<SessionStatus busy={chat.busy || chat.compacting} />
			<span className="min-w-0 flex-1">
				{/* v4: titles in the UI sans at row size — the sidebar is
				    navigation, not reading; the serif belongs to the page. */}
				<span className="block truncate text-sm font-semibold">{chat.title}</span>
				<span className="block truncate text-xs text-muted-foreground">{sessionMeta(chat)}</span>
			</span>
			{/* The dumbbell rides the FAR RIGHT (owner round 6, 2026-10-05) —
			    was left of the name; right-aligned keeps the titles flush with
			    the teaching rows and reads cleaner. */}
			{(chat.kind ?? "teach") === "practice" && (
				<DumbbellIcon className="size-3.5 shrink-0 text-faint" aria-label="Practice session" />
			)}
		</button>
	);
}

/** The inline-rename row (wave 6): same geometry as SessionRow, but the
 *  title line becomes a text input — select-all on entry (the click means
 *  "replace", the header rename's rule), Enter/blur commits, Esc discards.
 *  The meta line stays so the row never changes height mid-edit. */
export function RenameRow({ chat, onCommit, onCancel }: { chat: ChatListItem; onCommit: (next: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(chat.title);
	const inputRef = useRef<HTMLInputElement | null>(null);
	useEffect(() => {
		const el = inputRef.current;
		if (el) {
			el.focus();
			el.select();
		}
	}, []);
	return (
		<div
			data-testid="session-rename-row"
			className="relative flex w-full items-center rounded-md bg-accent px-2.5 py-1.5"
		>
			{/* NOTHING MOVES (owner, polish round): an idle row renders no
			    status spacer (SessionStatus is null when not busy), so the
			    title starts at the row's own px-3 — 12px in. The old rename
			    row always carried a 14px spacer + gap + the input's border
			    and padding, landing the text ~41px in (and the meta with
			    it). The input here is borderless and padding-free at the
			    exact title x; the underline is the only editing cue. */}
			<span className="flex min-w-0 w-full flex-col">
				<input
					ref={inputRef}
					value={draft}
					spellCheck={false}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => onCommit(draft)}
					onKeyDown={(e) => {
						if (e.key === "Enter") e.currentTarget.blur();
						if (e.key === "Escape") {
							e.stopPropagation(); // discard, not also the sidebar/chat chains
							onCancel();
						}
					}}
					aria-label="Rename session"
					data-testid="session-rename-input"
					className="w-full min-w-0 truncate border-0 border-b border-border bg-transparent px-0 text-sm font-semibold text-foreground outline-none"
				/>
				<span className="block truncate text-xs text-muted-foreground">{sessionMeta(chat)}</span>
			</span>
		</div>
	);
}

/** Pure: is this session waiting on the learner? A pending question, or a
 *  practice problem awaiting an answer. Exported for tests. */
export function isWaitingOnYou(chat: ChatListItem): boolean {
	return chat.pendingQuestion || ((chat.kind ?? "teach") === "practice" && chat.pendingProblem);
}

export interface SessionGroup {
	name: "Waiting on you" | "Today" | "Earlier";
	chats: ChatListItem[];
}

/** Pure: the sidebar's grouping (v4) — what needs you first, then today's
 *  sessions, then the rest; each group keeps the server's recency order.
 *  A turn in flight is not waiting on you, whatever its last state was.
 *  Empty groups are dropped. Exported for tests. */
export function groupSessions(chats: readonly ChatListItem[], now = new Date()): SessionGroup[] {
	const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
	const groups: SessionGroup[] = [
		{ name: "Waiting on you", chats: [] },
		{ name: "Today", chats: [] },
		{ name: "Earlier", chats: [] },
	];
	for (const c of chats) {
		if (!c.busy && isWaitingOnYou(c)) groups[0]!.chats.push(c);
		else if (new Date(c.updatedAt).getTime() >= startOfToday) groups[1]!.chats.push(c);
		else groups[2]!.chats.push(c);
	}
	return groups.filter((g) => g.chats.length > 0);
}

/** A sidebar destination — an expanded row or a rail icon, one component
 *  so the two widths can never disagree about where things go. */
function NavItem({
	expanded,
	href,
	onClick,
	label,
	icon: Icon,
	active = false,
	count,
	badge = false,
	action,
	testid,
}: {
	expanded: boolean;
	href?: string;
	onClick?: () => void;
	label: string;
	icon: typeof HouseIcon;
	active?: boolean;
	count?: number;
	badge?: boolean;
	action?: Parameters<typeof Hint>[0]["action"];
	testid?: string;
}) {
	const className = expanded
		? cn(
				"flex h-8 w-full items-center gap-2.5 rounded-md px-2.5 text-sm transition-colors",
				active ? "bg-popover font-semibold text-foreground shadow-[0_1px_2px_var(--shadow)]" : "text-muted-foreground hover:bg-accent hover:text-foreground",
			)
		: cn(
				"relative flex size-10 items-center justify-center rounded-xl transition-colors",
				active ? "bg-popover text-foreground shadow-[0_0_0_1px_var(--border)]" : "text-muted-foreground hover:bg-accent hover:text-foreground",
			);
	const body = (
		<>
			<Icon className={expanded ? "size-4 shrink-0" : "size-[18px]"} aria-hidden />
			{expanded && <span className="min-w-0 flex-1 truncate text-left">{label}</span>}
			{expanded && count !== undefined && <span className="font-mono text-xs text-faint tabular-nums">{count}</span>}
			{!expanded && badge && <span aria-hidden className="absolute right-1.5 top-1.5 size-2 rounded-full bg-warn" />}
		</>
	);
	const control = href ? (
		<Link href={href} aria-label={expanded ? undefined : label} aria-current={active ? "page" : undefined} className={className} data-testid={testid}>
			{body}
		</Link>
	) : (
		<button type="button" onClick={onClick} aria-label={expanded ? undefined : label} className={className} data-testid={testid}>
			{body}
		</button>
	);
	// The expanded row shows its own label; the rail needs the tooltip.
	return expanded && !action ? control : (
		<Hint label={label} action={action} side="right">
			{control}
		</Hint>
	);
}

function SessionsSidebar() {
	const { open, toggle } = useSidebar();
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const pathname = usePathname();
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const ideas = useGraphIndex();
	const { feed } = useActivity();
	const agentsRunning = useMemo(() => toBlobs(feed).length, [feed]);
	const groups = useMemo(() => (chats ? groupSessions(chats) : null), [chats]);
	const waitingCount = groups?.find((g) => g.name === "Waiting on you")?.chats.length ?? 0;

	const newSession = useCallback(() => {
		router.push("/chat/new");
	}, [router]);
	const openOmnibar = useCallback(() => window.dispatchEvent(new CustomEvent("lh:open-omnibar")), []);

	const refreshInFlightRef = useRef(false);
	const refresh = useCallback(async () => {
		// In-flight coalesce (S6): event bursts may land several refresh
		// calls at once — one fetch serves them all; anything newer arrives
		// with the next event's fetch.
		if (refreshInFlightRef.current) return;
		refreshInFlightRef.current = true;
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			const d = (await res.json()) as { chats: ChatListItem[] };
			setChats(d.chats);
		} catch {
			// a transient failure keeps the last snapshot
			setChats((prev) => prev ?? []);
		} finally {
			refreshInFlightRef.current = false;
		}
	}, []);

	/* Instant rename propagation (2026-09-17): the chat header's rename
	   commits dispatch lh:chat-renamed; patch the snapshot in place instead
	   of waiting for the 2.5s poll. */
	useEffect(() => {
		const onRenamed = (e: Event) => {
			const { id, title } = (e as CustomEvent<{ id: string; title: string }>).detail;
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, title } : c)) : prev));
		};
		window.addEventListener("lh:chat-renamed", onRenamed);
		return () => window.removeEventListener("lh:chat-renamed", onRenamed);
	}, []);

	/* INSTANT TURN-STATE (owner, sidebar round 2026-10-02): the open
	   session broadcasts lh:turn-state the instant its turn starts
	   (submitted — the optimistic machine's own flip) and at settle —
	   busy mirrors the server's own definition (isTurnRunning), so the
	   patch is exact: spinner up the moment the action happens, cleared
	   and refetched once at settle (title/order move with turns). The
	   events channel is the backstop for everything only the server
	   knows: other windows, wake turns in unopened sessions. A start on
	   a chat not yet in the snapshot (a brand-new session) = one
	   immediate refresh instead of a patch. */
	const chatsRef = useRef(chats);
	chatsRef.current = chats;
	useEffect(() => {
		const onTurnState = (e: Event) => {
			const { id, running } = (e as CustomEvent<{ id: string; running: boolean }>).detail;
			if (running) {
				if (chatsRef.current?.some((c) => c.id === id)) {
					setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: true } : c)) : prev));
				} else {
					void refresh(); // the brand-new session: it isn't in the snapshot yet
				}
				return;
			}
			setChats((prev) => (prev ? prev.map((c) => (c.id === id ? { ...c, busy: false } : c)) : prev));
			void refresh(); // settle: the server snapshot is now truthful — land it now
		};
		window.addEventListener("lh:turn-state", onTurnState);
		return () => window.removeEventListener("lh:turn-state", onTurnState);
	}, [refresh]);

	/* PUSH (architecture S6, 2026-10-02): the 2.5s poll is RETIRED — the
	   last standing network poll in the app. List truth arrives as
	   events: chats-changed (create/rename/delete — the list-SHAPE
	   writes), and turn-started/turn-settled for EVERY chat (unfiltered:
	   any chat's turn flips busy/order/phase in this list). Announced
	   fetches ride the 250ms trailing debounce (the S4/S5 law); resync
	   (reconnect / dev-restart) is immediate. lh:turn-state +
	   lh:chat-renamed stay for same-tab INSTANTS — local beats any
	   round-trip. */
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	const eventDebounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const scheduleEventRefresh = () => {
		if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		eventDebounceRef.current = setTimeout(() => {
			eventDebounceRef.current = undefined;
			void refreshRef.current();
		}, 250);
	};
	useServerEvent("chats-changed", scheduleEventRefresh);
	useServerEvent("turn-started", scheduleEventRefresh);
	useServerEvent("turn-settled", scheduleEventRefresh);
	useServerEvent("compaction-changed", scheduleEventRefresh);
	useServerResync(() => void refreshRef.current());
	useEffect(
		() => () => {
			if (eventDebounceRef.current) clearTimeout(eventDebounceRef.current);
		},
		[],
	);

	/* ── Wave 6 chunk A: context menu + inline rename + deletion ──
	   Right-click a session row → MenuShell: the two management actions
	   first (owner ruling), then — below a hairline — the extraction
	   coverage block (owner-locked redesign 2026-09-24, order refined
	   2026-09-24: Rename/Delete on top, the numbers + manual Extract
	   affordance at the bottom). The anchor is the row that was
	   right-clicked — assigned into a ref before the state flip so the
	   shell measures it on its first (hidden) pass. */
	const [ctxChatId, setCtxChatId] = useState<string | null>(null);
	const ctxAnchorRef = useRef<HTMLElement | null>(null);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<ChatListItem | null>(null);

	const openContext = (e: React.MouseEvent<HTMLButtonElement>, chat: ChatListItem) => {
		e.preventDefault(); // suppress the native menu
		ctxAnchorRef.current = e.currentTarget;
		setCtxChatId(chat.id);
	};

	// The menu contract (agent-section's): any pointerdown outside the menu
	// or its row closes it; Esc is CLAIMED so it never also aborts a turn
	// or folds the sidebar. Right-clicking another row re-anchors: its
	// pointerdown closes this menu, its contextmenu opens the next.
	useEffect(() => {
		if (ctxChatId === null) return;
		const onPointerDown = (e: PointerEvent) => {
			const target = e.target as Node;
			if (target instanceof Element && target.closest("[data-lh-menu]")) return;
			if (ctxAnchorRef.current?.contains(target)) return;
			setCtxChatId(null);
		};
		const onKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtxChatId(null);
			}
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [ctxChatId]);

	// Inline rename (owner ruling, wave 6): the row swaps to a text input;
	// commit rides the SAME plumbing as the header rename — PUT the title,
	// then lh:chat-renamed patches every listener (this sidebar's own
	// listener patches the snapshot instantly; an open chat header hears
	// it too). Esc discards; empty commit discards (the header's rules).
	const commitRename = useCallback(async (id: string, next: string) => {
		setRenamingId(null);
		const t = next.trim();
		if (t === "") return;
		try {
			const res = await fetch(`/api/chats/${id}`, {
				method: "PUT",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ title: t }),
			});
			if (!res.ok) throw new Error(`rename failed: ${res.status}`);
			window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title: t } }));
		} catch (err) {
			console.error("rename failed:", err); // keep the old title
		}
	}, []);

	// Delete success: patch the list instantly (the poll is the backstop),
	// navigate home if the open session died (the chat view unmounts —
	// drafts die with it, no orphan bubbles), and announce the graph
	// revision so the graph view refetches (deletion is the one writer
	// the status poll can't see — no run ever transitions some→none).
	const onDeleted = useCallback(
		(id: string, _mode: ChatDeleteMode, graphRevision: number) => {
			setDeleting(null);
			setChats((prev) => (prev ? prev.filter((c) => c.id !== id) : prev));
			if (pathname === `/chat/${id}`) router.push("/");
			window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision } }));
		},
		[pathname, router],
	);

	useEffect(() => {
		void refresh();
		// Mount + navigation refetch (the rail's waiting badge needs the
		// list too); the events channel owns freshness (S6) — no interval.
	}, [pathname, refresh]);

	const practiceDraft = pathname === "/chat/new" && typeof window !== "undefined" && window.location.search.includes("mode=practice");

	return (
		<aside
			className={cn("sidebar-motion shrink-0 overflow-hidden duration-200", open ? "w-60" : "w-18")}
			data-testid="app-sidebar"
			data-expanded={open}
		>
			<div className={cn("flex h-full flex-col border-r border-border bg-card", open ? "w-60" : "w-18")}>
				{/* The top band: the window's drag surface in Electron. Expanded,
				    it carries the mark (after the traffic-light gutter) and the
				    collapse + new-lesson buttons; on the rail it is the lights'
				    own band (the mark moves down into the icon column). */}
				<div className={cn("lh-drag flex h-15 shrink-0 items-center gap-1", open ? "lh-lights-gutter pl-3 pr-2" : "justify-center")}>
					{open && (
						<>
							<Hint label="Home" side="right">
								<Link href="/" aria-label="Home" className="flex size-9 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent">
									<LhMark className="size-6" />
								</Link>
							</Hint>
							<span className="flex-1" />
							<Hint label="New lesson" action="new-session">
								<Button variant="ghost" size="icon" aria-label="New lesson" data-testid="new-session" onClick={newSession}>
									<PlusIcon className="size-4" />
								</Button>
							</Hint>
							<Hint label="Collapse sidebar" action="toggle-sidebar">
								<Button variant="ghost" size="icon" aria-label="Collapse sidebar" onClick={toggle}>
									<PanelLeftCloseIcon className="size-4" />
								</Button>
							</Hint>
						</>
					)}
				</div>

				{open ? (
					<>
						<nav aria-label="App" className="flex flex-col gap-0.5 px-2">
							<button
								type="button"
								onClick={openOmnibar}
								data-testid="omnibar-entry"
								className="mb-1.5 flex h-8 w-full items-center gap-2.5 rounded-md border border-border bg-popover px-2.5 text-sm text-faint transition-colors hover:text-muted-foreground"
							>
								<SearchIcon className="size-4 shrink-0" aria-hidden />
								<span className="flex-1 text-left">Search or start…</span>
								<kbd className="rounded border border-border px-1 font-mono text-xs">⌘K</kbd>
							</button>
							<NavItem expanded href="/" label="Home" icon={HouseIcon} active={pathname === "/"} />
							<NavItem expanded href="/knowledge" label="Knowledge" icon={WaypointsIcon} active={pathname === "/knowledge"} count={ideas?.length} />
							<NavItem expanded href="/chat/new?mode=practice" label="Practice" icon={DumbbellIcon} active={practiceDraft} testid="new-session-practice" />
						</nav>

						<div className="mt-3 flex-1 overflow-y-auto px-2 pb-2" data-testid="session-list">
							{groups === null ? (
								<div className="px-2.5 py-2 text-xs text-muted-foreground">Loading…</div>
							) : groups.length === 0 ? (
								<p className="px-2.5 py-2 text-xs text-muted-foreground">Your lessons will be listed here.</p>
							) : (
								groups.map((g) => (
									<section key={g.name} aria-label={g.name} className="mb-2">
										<h2 className="flex justify-between px-2.5 pb-1 pt-2 text-xs font-semibold text-faint">
											<span>{g.name}</span>
											<span className="tabular-nums">{g.chats.length}</span>
										</h2>
										<div className="flex flex-col gap-px">
											{g.chats.map((c) =>
												renamingId === c.id ? (
													<RenameRow
														key={c.id}
														chat={c}
														onCommit={(next) => void commitRename(c.id, next)}
														onCancel={() => setRenamingId(null)}
													/>
												) : (
													<SessionRow
														key={c.id}
														chat={c}
														active={pathname === `/chat/${c.id}`}
														onOpen={() => router.push(`/chat/${c.id}`)}
														onContextMenu={(e) => openContext(e, c)}
													/>
												),
											)}
										</div>
									</section>
								))
							)}
						</div>

						{/* Background agents (v4): only while something runs — an empty
						    header was chrome without information. The rail shows the
						    same signal as a live icon. */}
						{agentsRunning > 0 && <ActivitySection />}

						<div className="border-t border-border px-2 py-2">
							<NavItem expanded onClick={() => openSettings()} label="Settings" icon={SettingsIcon} action="open-settings" testid="settings-entry" />
						</div>
					</>
				) : (
					<nav aria-label="App" className="flex flex-1 flex-col items-center gap-1 pb-3">
						<Link href="/" aria-label="Home" className="mb-2 flex size-10 items-center justify-center rounded-xl transition-colors hover:bg-accent">
							<LhMark className="size-6" />
						</Link>
						<NavItem expanded={false} onClick={openOmnibar} label="Search or start" icon={SearchIcon} action="open-omnibar" testid="omnibar-entry" />
						<NavItem expanded={false} href="/" label="Home" icon={HouseIcon} active={pathname === "/"} />
						<NavItem
							expanded={false}
							onClick={toggle}
							label={waitingCount > 0 ? `Sessions · ${waitingCount} waiting on you` : "Sessions"}
							icon={ListIcon}
							badge={waitingCount > 0}
							action="toggle-sidebar"
						/>
						<NavItem expanded={false} href="/knowledge" label="Knowledge" icon={WaypointsIcon} active={pathname === "/knowledge"} action="jump-graph" />
						<NavItem expanded={false} href="/chat/new?mode=practice" label="Practice" icon={DumbbellIcon} active={practiceDraft} testid="new-session-practice" />
						<Hint label="New lesson" action="new-session" side="right">
							<button
								type="button"
								aria-label="New lesson"
								data-testid="new-session"
								onClick={newSession}
								className="mt-2 flex size-10 items-center justify-center rounded-xl bg-primary text-primary-foreground transition-colors hover:bg-primary/90"
							>
								<PlusIcon className="size-4" />
							</button>
						</Hint>
						<span className="flex-1" />
						{agentsRunning > 0 && (
							<NavItem expanded={false} onClick={toggle} label={`${agentsRunning} background agent${agentsRunning === 1 ? "" : "s"} running`} icon={ActivityIcon} badge />
						)}
						<NavItem expanded={false} onClick={() => openSettings()} label="Settings" icon={SettingsIcon} action="open-settings" testid="settings-entry" />
						<Hint label="Expand sidebar" action="toggle-sidebar" side="right">
							<button type="button" aria-label="Expand sidebar" onClick={toggle} className="flex size-10 items-center justify-center rounded-xl text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
								<PanelLeftOpenIcon className="size-[18px]" />
							</button>
						</Hint>
					</nav>
				)}
			</div>

				{/* The context menu (wave 6 + the extraction-UX redesign): the
				    coverage block above, then exactly two management actions
				    (owner ruling — no more). MenuShell owns placement/focus/arrow
				    cycling; the dismissal effect above owns the contract. */}
				{ctxChatId !== null && (
					<MenuShell
						anchorRef={ctxAnchorRef}
						testid="session-context-menu"
						preferredSide="down"
						menuClass="flex w-52 flex-col gap-0.5 rounded-xl border bg-card p-2 text-xs shadow-xl"
					>
						{/* The two management actions first, then the extraction block
						    (owner refinement round, 2026-09-24): Rename/Delete stay at the
						    top, the coverage numbers + Extract affordance sit below the
						    hairline — the block is info + a stateful affordance, the
						    actions above it. Fetched on menu open (the block mounts WITH
						    the menu); 409 = benign. Renders nothing on a failed read. */}
						<button
							type="button"
							data-testid="ctx-rename"
							onClick={() => {
								setRenamingId(ctxChatId);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Rename
						</button>
						{/* Export as Markdown (owner, release polish 2026-10-06): the
					    session-markdown engine's user-facing debut — same-origin
						    anchor download; the route's Content-Disposition names the
						    file. Sits with the management actions, above Delete (the
						    destructive action stays last — the danger-fence law). */}
						<button
							type="button"
							data-testid="ctx-export-md"
							onClick={() => {
								const chatId = ctxChatId;
								setCtxChatId(null);
								const a = document.createElement("a");
								a.href = `/api/chats/${chatId}/markdown`;
								a.download = ""; // the route's filename wins
								document.body.appendChild(a);
								a.click();
								a.remove();
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-foreground transition-colors hover:bg-accent"
						>
							Export as Markdown…
						</button>
						<button
							type="button"
							data-testid="ctx-delete"
							onClick={() => {
								const target = chats?.find((c) => c.id === ctxChatId);
								if (target) setDeleting(target);
								setCtxChatId(null);
							}}
							className="flex items-center rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/80 transition-colors hover:bg-accent hover:text-foreground"
						>
							Delete…
						</button>
						<div className="my-0.5 border-t border-border/60" aria-hidden="true" />
						<CoverageMenuBlock chatId={ctxChatId} />
					</MenuShell>
				)}

				{/* The two-option delete dialog (wave 6) — portaled to body
				    by the component itself, lives here for state locality. */}
				<DeleteSessionDialog
					chat={deleting}
					onClose={() => setDeleting(null)}
					onDeleted={onDeleted}
				/>
		</aside>
	);
}

/** The app frame: sidebar inline + content. Rendered once in the root layout. */
export function AppShell({ children }: { children: React.ReactNode }) {
	return (
		<SettingsDialogProvider>
			<SessionsSidebar />
			<main className="min-w-0 flex-1">{children}</main>
			<CommandPalette />
			{/* The single document-level keydown listener (keyboard wave A) —
			    after the content in the tree, but it's window-level so order only
			    matters for the events it dispatches, never for DOM priority. */}
			<KeyboardShortcuts />
		</SettingsDialogProvider>
	);
}
