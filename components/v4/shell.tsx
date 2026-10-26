"use client";

/**
 * THE V4 SHELL (rebuild, 2026-10-26; finesse pass) — the pieces every
 * screen frames itself with:
 *
 *   Field        the drifting gradient behind everything (paused when the
 *                window is in the background; still under reduced motion)
 *   SidebarCard  the inset glass card at ≥1100px: wordmark, Home /
 *                Knowledge, New lesson / New practice, a screen-owned middle (sessions by
 *                default, topics on Knowledge), a footer (Settings, or
 *                Import notes). Between 800 and 1099px the same frame
 *                renders as the icon rail; below 800 the rail lies flat
 *                along the top. CSS decides which one shows (no layout
 *                flash on first paint).
 *   SessionGroups  Waiting on you / Today / Earlier, capped per group, then
 *                a collapsed Archived group; the right-click menu (rename,
 *                export, archive, delete, extraction coverage)
 *   Rail         the icon column of Lesson and Practice, with the
 *                sessions flyout (hover, focus, click, or ⌘B) — the very
 *                same component the sidebar card collapses into
 *
 * Styles: app/ui/shell.css.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { DeleteSessionDialog } from "@/components/delete-session-dialog";
import { CoverageMenuBlock } from "@/components/extraction-coverage";
import { MenuShell } from "@/components/menu-shell";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { Icon, LogoMark, type IconName } from "@/components/ui/icon";
import { displayTitle } from "@/components/ui/format";
import { kbdEventForAction, type ChatDeleteMode } from "@/src/core";
import { groupChats, isPractice, sessionLine, sessionState, useChats, type V4Chat } from "@/components/v4/data";

/** Rows shown per group before "Show all" (a real library runs to hundreds). */
const GROUP_CAP = 8;

type Place = "home" | "knowledge" | "practice";

const NAV: Array<{ href: string; label: string; icon: IconName; place: Place }> = [
	{ href: "/", label: "Home", icon: "home", place: "home" },
	{ href: "/knowledge", label: "Knowledge", icon: "knowledge", place: "knowledge" },
];

function placeOf(pathname: string | null): Place | undefined {
	return pathname === "/" ? "home" : pathname === "/knowledge" ? "knowledge" : pathname === "/practice" ? "practice" : undefined;
}

/** New lesson / New practice = Home's field, focused and ready for that
 *  kind (⌘N does New lesson). Already on Home, the event alone switches it;
 *  elsewhere the URL carries the mode for Home's first render. */
function useNewSession() {
	const router = useRouter();
	const pathname = usePathname();
	return useCallback(
		(mode: "teach" | "practice" = "teach") => {
			const ready = () => window.dispatchEvent(new CustomEvent("lh:focus-omnibar", { detail: { mode } }));
			if (pathname === "/") return ready();
			router.push(mode === "practice" ? "/?mode=practice" : "/");
			window.setTimeout(ready, 150);
		},
		[router, pathname],
	);
}

// ─── Field ─────────────────────────────────────────────────────────────────

export function Field({ variant = "home" }: { variant?: "home" | "knowledge" | "warm" }) {
	// Pause the drift while the window is hidden — no GPU work nobody sees.
	const [still, setStill] = useState(false);
	useEffect(() => {
		const on = () => setStill(document.visibilityState !== "visible");
		on();
		document.addEventListener("visibilitychange", on);
		return () => document.removeEventListener("visibilitychange", on);
	}, []);
	return (
		<div className={`field ${variant === "home" ? "" : variant} ${still ? "still" : ""}`} aria-hidden="true">
			<div className="blob k1" />
			<div className="blob k2" />
			{variant !== "knowledge" && <div className="blob k3" />}
		</div>
	);
}

// ─── Sidebar card ──────────────────────────────────────────────────────────

/** The sidebar card. With no `children` its middle is the session list;
 *  a screen may pass its own (Knowledge passes topics) — in rail mode that
 *  middle and the footer move into the rail's panel flyout. */
export function SidebarCard({
	children,
	footer,
	knowledgeCount,
}: {
	children?: ReactNode;
	footer?: ReactNode;
	knowledgeCount?: number | null;
}) {
	const pathname = usePathname();
	const chats = useChats();
	const { open: openSettings } = useSettingsDialog();
	const newSession = useNewSession();
	const here = placeOf(pathname);
	return (
		<>
			<aside className="side" aria-label="Navigation">
				<div className="sidein glass">
					<div className="side-brand lh-drag">
						<Link href="/" className="side-logo" aria-label="LearnHarness home">
							<LogoMark size={24} />
							<span>LearnHarness</span>
						</Link>
						<button type="button" className="ib sm tipb" aria-label="New lesson" data-tip="New lesson  ⌘N" onClick={() => newSession("teach")}>
							<Icon name="plus" size="sm" />
						</button>
					</div>
					<nav className="side-nav" aria-label="Places">
						{NAV.map((n) => {
							const on = here === n.place;
							const count = n.place === "knowledge" ? knowledgeCount : null;
							return (
								<Link key={n.href} className={`srow ${on ? "on" : ""}`} href={n.href} aria-current={on ? "page" : undefined}>
									<Icon name={n.icon} size="md" />
									<span>{n.label}</span>
									{count != null && <span className="srow-count num">{count}</span>}
								</Link>
							);
						})}
					</nav>
					<div className="side-new" role="group" aria-label="Start">
						<button type="button" className="srow side-new-b" onClick={() => newSession("teach")}>
							<Icon name="plus" size="md" />
							<span>New lesson</span>
						</button>
						<button type="button" className="srow side-new-b" onClick={() => newSession("practice")}>
							<Icon name="plus" size="md" />
							<span>New practice</span>
						</button>
					</div>
					<div className="side-mid">{children ?? <SessionGroups chats={chats} />}</div>
					<div className="side-foot">
						{footer ?? (
							<button type="button" className="srow" onClick={() => openSettings()} data-testid="settings-entry">
								<Icon name="settings" size="md" />
								<span>Settings</span>
							</button>
						)}
					</div>
				</div>
			</aside>
			<div className="side-rail">
				<RailNav
					chats={chats}
					active={here}
					embedded
					panel={children !== undefined || footer !== undefined ? { label: "Topics", content: (<>{children}{footer && <div className="fly-foot">{footer}</div>}</>) } : undefined}
				/>
			</div>
		</>
	);
}

// ─── Session groups (+ the session context menu) ───────────────────────────

/** The session rows of the sidebar card and the rail flyout. Right-click a
 *  row for Rename / Export as Markdown / Delete, with the extraction
 *  coverage block below (the management menu the old sidebar carried). */
export function SessionGroups({ chats, compact = false }: { chats: V4Chat[] | null; compact?: boolean }) {
	const pathname = usePathname();
	const router = useRouter();
	const groups = useMemo(() => groupChats(chats ?? []), [chats]);
	const [ctx, setCtx] = useState<string | null>(null);
	const anchorRef = useRef<HTMLElement | null>(null);
	const [renaming, setRenaming] = useState<string | null>(null);
	const [deleting, setDeleting] = useState<V4Chat | null>(null);
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());

	useEffect(() => {
		if (ctx === null) return;
		const onDown = (e: PointerEvent) => {
			const t = e.target as Node;
			if (t instanceof Element && t.closest("[data-lh-menu]")) return;
			if (anchorRef.current?.contains(t)) return;
			setCtx(null);
		};
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.stopPropagation();
				setCtx(null);
			}
		};
		document.addEventListener("pointerdown", onDown);
		document.addEventListener("keydown", onKey);
		return () => {
			document.removeEventListener("pointerdown", onDown);
			document.removeEventListener("keydown", onKey);
		};
	}, [ctx]);

	const setArchived = useCallback(async (id: string, archived: boolean) => {
		const res = await fetch(`/api/chats/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ archived }),
		}).catch(() => null);
		if (res?.ok) window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id } }));
	}, []);

	const commitRename = useCallback(async (id: string, next: string) => {
		setRenaming(null);
		const t = next.trim();
		if (!t) return;
		const res = await fetch(`/api/chats/${id}`, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ title: t }),
		}).catch(() => null);
		if (res?.ok) window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id, title: t } }));
	}, []);

	const onDeleted = useCallback(
		(id: string, _mode: ChatDeleteMode, graphRevision: number) => {
			setDeleting(null);
			if (pathname === `/chat/${id}`) router.push("/");
			window.dispatchEvent(new CustomEvent("lh:chat-renamed", { detail: { id } }));
			window.dispatchEvent(new CustomEvent("lh:graph-revision", { detail: { revision: graphRevision } }));
		},
		[pathname, router],
	);

	if (chats === null) {
		return (
			<div className="sess-skel" aria-hidden="true">
				{[0, 1, 2, 3].map((i) => (
					<span key={i}>
						<i className="skel" />
						<i className="skel" />
					</span>
				))}
			</div>
		);
	}
	if (groups.length === 0) {
		return (
			<div className="sess-empty">
				<Icon name="lesson" size="md" />
				<span>Your lessons will be listed here as you start them.</span>
			</div>
		);
	}
	return (
		<div className={`sgroups ${compact ? "compact" : ""}`}>
			{groups.map((g) => {
				const all = expanded.has(g.name);
				const activeAt = g.chats.findIndex((c) => pathname === `/chat/${c.id}`);
				// Archived folds shut until opened (the open session keeps it
				// open); live groups are capped, the open session always in view.
				const archive = g.name === "Archived";
				const archiveOpen = archive && (all || activeAt !== -1);
				const shown = archive
					? archiveOpen
						? g.chats
						: []
					: all
						? g.chats
						: g.chats.filter((_, i) => i < GROUP_CAP || i === activeAt);
				const toggle = () =>
					setExpanded((s) => {
						const next = new Set(s);
						if (all) next.delete(g.name);
						else next.add(g.name);
						return next;
					});
				return (
					<section key={g.name} className={`sgroup ${archive ? "archived" : ""}`} aria-label={g.name}>
						{archive ? (
							<button type="button" className="gl gl-toggle" aria-expanded={archiveOpen} onClick={toggle}>
								<span>
									<Icon name="chevron-right" size="xs" className="gl-chev" />
									{g.name}
								</span>
								<span className="num">{g.chats.length}</span>
							</button>
						) : (
							<div className="gl">
								<span>{g.name}</span>
								<span className="num">{g.chats.length}</span>
							</div>
						)}
						{shown.map((c) => {
							const on = pathname === `/chat/${c.id}`;
							const state = sessionState(c);
							return renaming === c.id ? (
								<RenameRow key={c.id} chat={c} onCommit={(t) => void commitRename(c.id, t)} onCancel={() => setRenaming(null)} />
							) : (
								<button
									key={c.id}
									type="button"
									className={`sess ${on ? "on" : ""} ${ctx === c.id ? "ctx" : ""}`}
									data-testid="session-row"
									aria-current={on ? "page" : undefined}
									title={displayTitle(c.title)}
									onClick={() => router.push(`/chat/${c.id}`)}
									onContextMenu={(e) => {
										e.preventDefault();
										anchorRef.current = e.currentTarget;
										setCtx(c.id);
									}}
								>
									<span className={`sess-mark ${state}`} aria-hidden="true">
										<Icon name={isPractice(c) ? "practice" : "lesson"} size="sm" />
										{state === "waiting" && <span className="ping" />}
									</span>
									<span className="sess-t trunc">{displayTitle(c.title)}</span>
									<span className="sess-m trunc">{sessionLine(c)}</span>
								</button>
							);
						})}
						{!archive && g.chats.length > GROUP_CAP && (
							<button type="button" className="sess-more" aria-expanded={all} onClick={toggle}>
								<Icon name={all ? "chevron-up" : "chevron-down"} size="xs" />
								{all ? "Show fewer" : `Show all ${g.chats.length}`}
							</button>
						)}
					</section>
				);
			})}
			{ctx !== null && (
				<MenuShell anchorRef={anchorRef} testid="session-context-menu" preferredSide="down" menuClass="v4 scope ctx-menu">
					<button type="button" className="mrow" data-testid="ctx-rename" onClick={() => (setRenaming(ctx), setCtx(null))}>
						<Icon name="edit" size="sm" />
						Rename
					</button>
					<button
						type="button"
						className="mrow"
						data-testid="ctx-export-md"
						onClick={() => {
							const id = ctx;
							setCtx(null);
							const a = document.createElement("a");
							a.href = `/api/chats/${id}/markdown`;
							a.download = "";
							document.body.appendChild(a);
							a.click();
							a.remove();
						}}
					>
						<Icon name="download" size="sm" />
						Export as Markdown
					</button>
					<ArchiveItem
						archived={chats.find((c) => c.id === ctx)?.archived === true}
						onClick={(archived) => {
							const id = ctx;
							setCtx(null);
							void setArchived(id, !archived);
						}}
					/>
					<div className="msep" aria-hidden="true" />
					<button
						type="button"
						className="mrow danger"
						data-testid="ctx-delete"
						onClick={() => {
							setDeleting(chats.find((c) => c.id === ctx) ?? null);
							setCtx(null);
						}}
					>
						<Icon name="delete" size="sm" />
						Delete…
					</button>
					<div className="msep" aria-hidden="true" />
					<div className="ctx-coverage">
						<CoverageMenuBlock chatId={ctx} />
					</div>
				</MenuShell>
			)}
			<DeleteSessionDialog chat={deleting} onClose={() => setDeleting(null)} onDeleted={onDeleted} />
		</div>
	);
}

function ArchiveItem({ archived, onClick }: { archived: boolean; onClick: (archived: boolean) => void }) {
	return (
		<button type="button" className="mrow" data-testid="ctx-archive" onClick={() => onClick(archived)}>
			<Icon name={archived ? "unarchive" : "archive"} size="sm" />
			{archived ? "Unarchive" : "Archive"}
		</button>
	);
}

function RenameRow({ chat, onCommit, onCancel }: { chat: V4Chat; onCommit: (t: string) => void; onCancel: () => void }) {
	const [draft, setDraft] = useState(chat.title);
	const ref = useRef<HTMLInputElement>(null);
	useEffect(() => {
		ref.current?.focus();
		ref.current?.select();
	}, []);
	return (
		<div className="sess on renaming" data-testid="session-rename-row">
			<span className="sess-mark" aria-hidden="true">
				<Icon name="edit" size="xs" />
			</span>
			<input
				ref={ref}
				className="sess-input"
				value={draft}
				aria-label="Rename session"
				data-testid="session-rename-input"
				spellCheck={false}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={() => onCommit(draft)}
				onKeyDown={(e) => {
					if (e.key === "Enter") e.currentTarget.blur();
					if (e.key === "Escape") {
						e.stopPropagation();
						onCancel();
					}
				}}
			/>
			<span className="sess-m trunc">Enter to save · Esc to cancel</span>
		</div>
	);
}

// ─── Rail ──────────────────────────────────────────────────────────────────

/** The rail of Lesson and Practice. */
export function Rail({ active }: { active?: Place }) {
	const chats = useChats();
	return <RailNav chats={chats} active={active} />;
}

/** One rail item's tooltip (a real element, so it can carry a key hint). */
function Tip({ label, keys }: { label: string; keys?: string }) {
	return (
		<span className="tip" aria-hidden="true">
			{label}
			{keys && <span className="tip-k">{keys}</span>}
		</span>
	);
}

/** A hover/focus/click flyout anchored to a rail button. Closing waits a
 *  beat so the pointer can cross from the button to the panel. */
function useFlyout() {
	const [open, setOpen] = useState(false);
	const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const show = useCallback(() => {
		clearTimeout(timer.current);
		setOpen(true);
	}, []);
	const hide = useCallback(() => {
		clearTimeout(timer.current);
		timer.current = setTimeout(() => setOpen(false), 160);
	}, []);
	useEffect(() => () => clearTimeout(timer.current), []);
	const wrap = {
		onMouseEnter: show,
		onMouseLeave: hide,
		onFocus: show,
		onBlur: (e: React.FocusEvent<HTMLDivElement>) => {
			if (!e.currentTarget.contains(e.relatedTarget as Node)) hide();
		},
	};
	return { open, setOpen, wrap };
}

function RailNav({
	chats,
	active,
	embedded = false,
	panel,
}: {
	chats: V4Chat[] | null;
	active?: Place;
	/** Inside the sidebar card's rail mode: the card owns the settings testid. */
	embedded?: boolean;
	/** A screen's own sidebar middle (Knowledge's topics), as a second flyout. */
	panel?: { label: string; content: ReactNode };
}) {
	const { open: openSettings } = useSettingsDialog();
	const newSession = useNewSession();
	const waiting = (chats ?? []).filter((c) => !c.archived && sessionState(c) === "waiting").length;
	const sessions = useFlyout();
	const extra = useFlyout();
	const railRef = useRef<HTMLElement>(null);
	const { setOpen: setSessionsOpen } = sessions;

	// ⌘B toggles the sessions flyout — only on the rail that is showing.
	useEffect(() => {
		const event = kbdEventForAction("toggle-sidebar");
		const on = () => {
			if (railRef.current?.offsetParent === null) return;
			setSessionsOpen((v) => !v);
		};
		window.addEventListener(event, on);
		return () => window.removeEventListener(event, on);
	}, [setSessionsOpen]);

	const sessionsLabel = waiting ? `Sessions, ${waiting} waiting on you` : "Sessions";
	return (
		<nav ref={railRef} className="rail" aria-label="App">
			<div className="rail-lights lh-drag" aria-hidden="true" />
			<Link className="ri logo" href="/" aria-label="LearnHarness home">
				<LogoMark size={28} />
			</Link>
			<Link className={`ri ${active === "home" ? "on" : ""}`} href="/" aria-label="Home" aria-current={active === "home" ? "page" : undefined}>
				<Icon name="home" size="lg" />
				<Tip label="Home" />
			</Link>
			<div className="ri-wrap" {...sessions.wrap}>
				<button
					type="button"
					className={`ri ${sessions.open ? "open" : ""}`}
					aria-label={sessionsLabel}
					aria-haspopup="true"
					aria-expanded={sessions.open}
					onClick={() => sessions.setOpen((v) => !v)}
				>
					<Icon name="sessions" size="lg" />
					{waiting > 0 && <span className="badge" aria-hidden="true" />}
					{!sessions.open && <Tip label={waiting ? `Sessions · ${waiting} waiting` : "Sessions"} keys="⌘B" />}
				</button>
				{sessions.open && (
					<nav className="fly pop settle" aria-label="Sessions">
						<div className="fly-head">
							<span className="h">Sessions</span>
							<button type="button" className="mini" onClick={() => newSession("teach")}>
								<Icon name="plus" size="sm" />
								New lesson
							</button>
						</div>
						<SessionGroups chats={chats} compact />
					</nav>
				)}
			</div>
			<Link className={`ri ${active === "knowledge" ? "on" : ""}`} href="/knowledge" aria-label="Knowledge" aria-current={active === "knowledge" ? "page" : undefined}>
				<Icon name="knowledge" size="lg" />
				<Tip label="Knowledge" />
			</Link>
			{panel && (
				<div className="ri-wrap" {...extra.wrap}>
					<button type="button" className={`ri ${extra.open ? "open" : ""}`} aria-label={panel.label} aria-haspopup="true" aria-expanded={extra.open} onClick={() => extra.setOpen((v) => !v)}>
						<Icon name="outline" size="lg" />
						{!extra.open && <Tip label={panel.label} />}
					</button>
					{extra.open && (
						<div className="fly pop settle" role="group" aria-label={panel.label}>
							{panel.content}
						</div>
					)}
				</div>
			)}
			<span className="rail-sep" aria-hidden="true" />
			<button type="button" className="ri new" aria-label="New lesson" onClick={() => newSession("teach")}>
				<Icon name="plus" size="lg" />
				<Tip label="New lesson" keys="⌘N" />
			</button>
			<button type="button" className="ri new-prac" aria-label="New practice" onClick={() => newSession("practice")}>
				<Icon name="practice" size="lg" />
				<span className="ri-plus" aria-hidden="true">
					<Icon name="plus" size="xs" strokeWidth={3} />
				</span>
				<Tip label="New practice" />
			</button>
			<button type="button" className="ri foot" aria-label="Settings" onClick={() => openSettings()} data-testid={embedded ? undefined : "settings-entry"}>
				<Icon name="settings" size="lg" />
				<Tip label="Settings" />
			</button>
		</nav>
	);
}
