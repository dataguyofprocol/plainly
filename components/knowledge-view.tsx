"use client";

/**
 * KNOWLEDGE — the knowledge graph page (v4). The sidebar card lists the
 * topics (click one to zoom to it); the canvas is the graph engine
 * (graph-view.tsx, v4 mode) in topic colours; clicking an idea opens its
 * card — what it rests on, what it leads to, where it was learned — and
 * lights its chain; ideas collect in the practice tray and leave as one
 * practice set. Styles: app/ui/knowledge.css.
 */

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { GraphView, ideaNeighbours, type GraphViewApi } from "@/components/graph-view";
import { NotesImportErrors, useNotesImport } from "@/components/notes-import";
import { SetupDialog } from "@/components/setup-dialog";
import { createSession, useStartReadiness, type StartPick } from "@/components/start-session";
import { EmptyState } from "@/components/ui/empty-state";
import { displayTitle, displayTopic } from "@/components/ui/format";
import { Hint } from "@/components/ui/hint";
import { Icon } from "@/components/ui/icon";
import { ago, chainNeighbourhood, topicColor, useGraphSnapshot, useTopics } from "@/components/v4/data";
import { Field, SidebarCard } from "@/components/v4/shell";
import { bindingForAction, formatBinding, type GraphNode, type GraphSnapshot } from "@/src/core";

/** How many related ideas the card names before "Show N more". */
const NEIGHBOUR_LIMIT = 4;
/** The map hint stays dismissed for this viewer (a convenience only). */
const HINT_KEY = "lh.knowledge.hint.dismissed";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The ideas a topic zoom frames: its CORE — members within twice the
 *  median distance of its centre — so a few strays far across the map
 *  don't keep the camera at the whole-graph view. Display-only. */
function topicCore(ids: string[], positions: Record<string, { x: number; y: number }> | undefined): string[] {
	const pts = positions ? ids.flatMap((id) => (positions[id] ? [{ id, ...positions[id]! }] : [])) : [];
	if (pts.length < 4) return ids;
	const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
	const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
	const d = pts.map((p) => Math.hypot(p.x - cx, p.y - cy));
	const reach = [...d].sort((a, b) => a - b)[Math.floor(d.length / 2)]! * 2;
	const core = pts.filter((_, i) => d[i]! <= reach).map((p) => p.id);
	return core.length > 0 ? core : ids;
}

export function KnowledgeView({ initialConfigured, focusIdeaId }: { initialConfigured: boolean; rendering?: boolean; focusIdeaId?: string }) {
	const router = useRouter();
	const snapshot = useGraphSnapshot();
	const topics = useTopics();
	const readiness = useStartReadiness(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);
	const api = useRef<GraphViewApi | null>(null);
	const [zoomPct, setZoomPct] = useState(100);
	const [q, setQ] = useState("");
	const [topic, setTopic] = useState<string | null>(null);
	const [sel, setSel] = useState<GraphNode | null>(null);
	const [tray, setTray] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	const notesImport = useNotesImport();
	const [errorsHidden, setErrorsHidden] = useState(false);
	const fileRef = useRef<HTMLInputElement>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const [now, setNow] = useState<Date | null>(null);
	const [findKey, setFindKey] = useState<string | null>(null);
	const [hintOpen, setHintOpen] = useState(false);
	useEffect(() => {
		setNow(new Date());
		// Client-only: the live (override-aware) Find binding, and whether
		// this viewer already dismissed the map hint.
		setFindKey(formatBinding(bindingForAction("find")));
		try {
			setHintOpen(localStorage.getItem(HINT_KEY) !== "1");
		} catch {
			setHintOpen(true);
		}
	}, []);

	// A fresh import's errors show again even if the last ones were closed.
	useEffect(() => setErrorsHidden(false), [notesImport.errors]);

	// ⌘F: the page owns the graph's search.
	useEffect(() => {
		const onFind = () => {
			searchRef.current?.focus();
			searchRef.current?.select();
		};
		window.addEventListener("lh:kbd-find", onFind);
		return () => window.removeEventListener("lh:kbd-find", onFind);
	}, []);

	const props = useMemo(() => snapshot?.propositions ?? [], [snapshot]);
	const byId = useMemo(() => new Map(props.map((n) => [n.id, n])), [props]);
	const topicOf = useMemo(() => {
		const m = new Map<string, { id: string; name: string }>();
		for (const t of topics ?? []) for (const id of t.ideaIds) m.set(id, { id: t.id, name: t.name });
		return m;
	}, [topics]);
	// The canvas labels wear the topic list's names. Keyed by content so
	// the canvas re-feeds only when a name actually changes.
	const namesKey = (topics ?? []).map((t) => `${t.id}\u0000${t.name}`).join("\u0001");
	const topicNames = useMemo(
		() => (namesKey ? new Map(namesKey.split("\u0001").map((row) => row.split("\u0000") as [string, string])) : null),
		[namesKey],
	);

	// Arrival focus (/knowledge?idea=…): select and frame it once known.
	const focusDone = useRef(false);
	useEffect(() => {
		if (!focusIdeaId || focusDone.current || !byId.has(focusIdeaId)) return;
		focusDone.current = true;
		setSel(byId.get(focusIdeaId)!);
		window.setTimeout(() => api.current?.frame([focusIdeaId]), 300);
	}, [focusIdeaId, byId]);

	// Keep the zoom readout live.
	useEffect(() => {
		const t = window.setInterval(() => api.current && setZoomPct(api.current.zoomPercent()), 400);
		return () => window.clearInterval(t);
	}, []);

	// Esc closes the idea card (dialogs claim Esc at the document first).
	useEffect(() => {
		if (!sel) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			const t = e.target as HTMLElement | null;
			if (t?.closest("input, textarea, [contenteditable]")) return;
			setSel(null);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [sel]);

	const highlight = useMemo(
		() => (sel && snapshot ? { ids: chainNeighbourhood(snapshot.edges, sel.id), selected: sel.id } : null),
		[sel, snapshot],
	);
	const focusIds = useMemo(() => {
		const t = topic ? topics?.find((x) => x.id === topic) : null;
		return t ? new Set(t.ideaIds) : null;
	}, [topic, topics]);
	const matches = useMemo(() => {
		const t = q.trim().toLowerCase();
		if (!t) return null;
		return props.filter((n) => n.name.toLowerCase().includes(t) || n.statement.toLowerCase().includes(t)).length;
	}, [q, props]);

	const lessons = (topics ?? []).filter((t) => !t.id.startsWith("src_")).length;
	const notes = (topics ?? []).filter((t) => t.id.startsWith("src_")).length;
	const sources = [lessons > 0 ? plural(lessons, "lesson") : null, notes > 0 ? plural(notes, "note") : null].filter(Boolean).join(" and ");
	const empty = snapshot !== null && props.length === 0;

	const pick = (id: string) => {
		const n = byId.get(id);
		if (!n) return;
		setSel(n);
		api.current?.frame([id]);
	};

	const practiceTray = async () => {
		if (busy || tray.length === 0) return;
		if (!readiness.ready) return setSetupOpen(true);
		setBusy(true);
		const picks: StartPick[] = tray.flatMap((id) => {
			const n = byId.get(id);
			return n ? [{ id: n.id, name: n.name, statement: n.statement }] : [];
		});
		const title = `Practice: ${picks.map((p) => p.name).slice(0, 3).join(", ")}${picks.length > 3 ? ` and ${picks.length - 3} more` : ""}`;
		try {
			router.push(await createSession(title, "practice", picks));
		} catch {
			setBusy(false);
		}
	};

	const closeHint = () => {
		setHintOpen(false);
		try {
			localStorage.setItem(HINT_KEY, "1");
		} catch {
			// best-effort: it just shows again next visit
		}
	};

	const startLesson = () => {
		router.push("/");
		window.setTimeout(() => window.dispatchEvent(new CustomEvent("lh:focus-omnibar")), 150);
	};

	return (
		<div className="v4 kpage">
			<Field variant="knowledge" />
			{/* One file picker for every Import button (the sidebar, the rail's
			    topic flyout, the empty state) — outside the footer, which the
			    shell may mount twice. */}
			<input
				ref={fileRef}
				type="file"
				multiple
				accept=".md,.markdown,.txt"
				hidden
				onChange={(e) => {
					notesImport.onImportFiles(e.target.files);
					e.target.value = "";
				}}
			/>
			<div className="shell k">
				<SidebarCard
					knowledgeCount={props.length || null}
					footer={
						<Hint label="Add Markdown or text notes to the graph" side="top">
							<button type="button" className="ghost kimport" disabled={notesImport.importing} onClick={() => fileRef.current?.click()}>
								<Icon name={notesImport.importing ? "loading" : "import"} size="sm" className={notesImport.importing ? "kspin" : undefined} />
								{notesImport.importing ? "Importing…" : "Import notes"}
							</button>
						</Hint>
					}
				>
					<TopicList
						topics={topics}
						total={props.length}
						current={topic}
						onAll={() => {
							setTopic(null);
							api.current?.fit();
						}}
						onTopic={(id, ideaIds) => {
							setTopic(id);
							api.current?.frame(topicCore(ideaIds, snapshot?.positions));
						}}
					/>
				</SidebarCard>

				<main className="kmain">
					<header className="khead lh-drag lh-wco-gutter">
						<div className="khead-t">
							<h1 className="t-h2">Knowledge graph</h1>
							{snapshot === null ? (
								<span className="skel kmeta-skel" aria-hidden="true" />
							) : empty ? (
								<p className="kmeta">Nothing mapped yet</p>
							) : (
								<p className={`kmeta ${sources ? "tipb" : ""}`} data-tip={sources ? `From ${sources}` : undefined}>
									<span className="num">{plural(props.length, "idea")}</span>
									<span aria-hidden="true"> · </span>
									<span className="num">{plural(snapshot.chains.length, "chain")}</span>
								</p>
							)}
						</div>
						{!empty && (
							<div className="ksearch">
								<Icon name="search" size="sm" className="ksearch-ic" />
								<input
									ref={searchRef}
									className="finput sm"
									type="search"
									aria-label="Search ideas"
									placeholder="Search ideas"
									spellCheck={false}
									value={q}
									onChange={(e) => setQ(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Escape") {
											e.stopPropagation();
											if (q) setQ("");
											else e.currentTarget.blur();
										}
									}}
								/>
								{matches !== null ? (
									<span className={`ksearch-end num ${matches === 0 ? "none" : ""}`} aria-live="polite">
										{matches === 0 ? "No matches" : `${matches} found`}
									</span>
								) : (
									findKey && (
										<span className="ksearch-end kbd" aria-hidden="true">
											{findKey}
										</span>
									)
								)}
							</div>
						)}
					</header>

					<section className="canvas glass" aria-label={`Graph of ${plural(props.length, "idea")}`}>
						<div className="kstage">
							<GraphView
								variant="v4"
								query={q}
								apiRef={api}
								highlight={highlight}
								topicNames={topicNames}
								focusIds={focusIds}
								onSelectIdea={(s) => setSel(s?.node ?? null)}
							/>
						</div>

						{empty && (
							<div className="kempty">
								<EmptyState
									icon="knowledge"
									title="Your knowledge graph is empty"
									action={
										<div className="kempty-actions">
											<button type="button" className="btn brand" disabled={notesImport.importing} onClick={() => fileRef.current?.click()}>
												<Icon name="import" size="sm" />
												Import notes
											</button>
											<button type="button" className="ghost tall" onClick={startLesson}>
												<Icon name="learn" size="sm" />
												Start a lesson
											</button>
										</div>
									}
								>
									Every idea you learn in a lesson or bring in from your notes lands here, linked to the ideas it rests on.
								</EmptyState>
							</div>
						)}

						{!empty && matches === 0 && (
							<div className="kempty knomatch" data-testid="graph-no-match">
								<EmptyState
									icon="search"
									title={`No ideas match “${q.trim()}”`}
									action={
										<button
											type="button"
											className="ghost tall"
											onClick={() => {
												setQ("");
												searchRef.current?.focus();
											}}
										>
											<Icon name="close" size="sm" />
											Clear search
										</button>
									}
								>
									Search looks through idea names and statements.
								</EmptyState>
							</div>
						)}

						{notesImport.errors.length > 0 && !errorsHidden && (
							<div className="kerr pop settle" role="group" aria-label="Import problems">
								<div className="kerr-h">
									<Icon name="status-warn" size="sm" className="kerr-ic" />
									<span className="h">{notesImport.errors.length === 1 ? "A note didn’t import" : `${notesImport.errors.length} notes didn’t import`}</span>
									<button type="button" className="ib sm" aria-label="Dismiss" onClick={() => setErrorsHidden(true)}>
										<Icon name="close" size="sm" />
									</button>
								</div>
								<div className="kerr-list">
									<NotesImportErrors errors={notesImport.errors} />
								</div>
							</div>
						)}

						{sel && snapshot && (
							<IdeaCard
								key={sel.id}
								idea={sel}
								snapshot={snapshot}
								byId={byId}
								topicOf={topicOf}
								topicPracticedAt={topics?.find((t) => t.id === topicOf.get(sel.id)?.id)?.lastPracticedAt ?? null}
								now={now}
								inTray={tray.includes(sel.id)}
								onPick={pick}
								onClose={() => setSel(null)}
								onTray={() => setTray((t) => (t.includes(sel.id) ? t.filter((x) => x !== sel.id) : [...t, sel.id]))}
							/>
						)}

						{!empty && snapshot && hintOpen && tray.length === 0 && (
							<div className="khint pop hide-sm">
								<Icon name="info" size="sm" className="khint-ic" />
								<span>Click a topic to zoom in, an idea to see its chain</span>
								<button type="button" className="ib sm" aria-label="Dismiss hint" onClick={closeHint}>
									<Icon name="close" size="xs" />
								</button>
							</div>
						)}

						{!empty && snapshot && (
							<div className="kctrl pop" role="group" aria-label="Zoom">
								<Hint label="Zoom out" side="top">
									<button type="button" className="ib sm" aria-label="Zoom out" onClick={() => api.current?.zoomOut()}>
										<Icon name="minus" size="sm" />
									</button>
								</Hint>
								<span className="kzoom mono num" aria-label={`Zoom ${zoomPct}%`}>
									{zoomPct}%
								</span>
								<Hint label="Zoom in" side="top">
									<button type="button" className="ib sm" aria-label="Zoom in" onClick={() => api.current?.zoomIn()}>
										<Icon name="plus" size="sm" />
									</button>
								</Hint>
								<span className="kctrl-sep" aria-hidden="true" />
								<Hint label="Fit the whole graph" side="top">
									<button
										type="button"
										className="ib sm"
										aria-label="Fit"
										onClick={() => {
											setTopic(null);
											api.current?.fit();
										}}
									>
										<Icon name="fit" size="sm" />
									</button>
								</Hint>
							</div>
						)}

						{tray.length > 0 && (
							<div className={`tray pop settle ${sel ? "beside" : ""}`} role="region" aria-label="Practice tray">
								<span className="tray-n">
									<span className="tray-count num">{tray.length}</span>
									{tray.length === 1 ? "idea to practice" : "ideas to practice"}
								</span>
								<Hint label="Clear the tray" side="top">
									<button type="button" className="ib sm" aria-label="Clear" onClick={() => setTray([])}>
										<Icon name="close" size="sm" />
									</button>
								</Hint>
								<button type="button" className="btn sm brand" disabled={busy} onClick={() => void practiceTray()}>
									{busy ? <Icon name="loading" size="sm" className="kspin" /> : <Icon name="practice" size="sm" />}
									Practice them
								</button>
							</div>
						)}
					</section>
				</main>
			</div>
			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					readiness.markConfigured();
					setSetupOpen(false);
				}}
			/>
		</div>
	);
}

// ─── The topic list (the sidebar card's middle) ────────────────────────────

function TopicList({
	topics,
	total,
	current,
	onAll,
	onTopic,
}: {
	topics: ReturnType<typeof useTopics>;
	total: number;
	current: string | null;
	onAll: () => void;
	onTopic: (id: string, ideaIds: string[]) => void;
}) {
	if (topics === null)
		return (
			<div className="ktopics" aria-hidden="true">
				<div className="ktopics-h">
					<span className="over">Topics</span>
				</div>
				{[72, 56, 64, 48].map((w) => (
					<span key={w} className="ktopic-skel">
						<span className="skel" style={{ width: `${w}%` }} />
					</span>
				))}
			</div>
		);
	if (topics.length === 0) return null;
	return (
		<div className="ktopics">
			<div className="ktopics-h">
				<span className="over">Topics</span>
				<span className="ktopic-n mono num">{total}</span>
			</div>
			<button type="button" className={`ktopic ${current === null ? "on" : ""}`} aria-pressed={current === null} onClick={onAll} title="All topics">
				<Icon name="knowledge" size="xs" className="ktopic-all" />
				<span className="ktopic-l">All topics</span>
			</button>
			{topics.map((t) => {
				const name = displayTopic(t.name);
				return (
					<button
						key={t.id}
						type="button"
						className={`ktopic ${current === t.id ? "on" : ""}`}
						aria-pressed={current === t.id}
						title={name}
						onClick={() => onTopic(t.id, t.ideaIds)}
					>
						<span className="ksw" style={{ background: topicColor(t.id) }} />
						<span className="ktopic-l">{name}</span>
						<span className="ktopic-n mono num">{t.ideaIds.length}</span>
					</button>
				);
			})}
		</div>
	);
}

// ─── The idea card ─────────────────────────────────────────────────────────

function IdeaCard({
	idea,
	snapshot,
	byId,
	topicOf,
	topicPracticedAt,
	now,
	inTray,
	onPick,
	onClose,
	onTray,
}: {
	idea: GraphNode;
	snapshot: GraphSnapshot;
	byId: ReadonlyMap<string, GraphNode>;
	topicOf: ReadonlyMap<string, { id: string; name: string }>;
	topicPracticedAt: string | null;
	now: Date | null;
	inTray: boolean;
	onPick: (id: string) => void;
	onClose: () => void;
	onTray: () => void;
}) {
	const neighbours = useMemo(() => ideaNeighbours(snapshot.chains, idea.id), [snapshot, idea.id]);
	const topic = topicOf.get(idea.id);
	const concludes = snapshot.chains.some((c) => c.conclusion === idea.id);
	const firstSource = idea.provenance[0]?.chatId;
	const sourceName = firstSource ? (snapshot.sessions[firstSource] ?? snapshot.fileSources?.[firstSource] ?? null) : null;
	const learnedIn = sourceName ? (firstSource?.startsWith("src_") ? displayTopic(sourceName) : displayTitle(sourceName)) : null;

	return (
		<aside className="detail pop settle" aria-labelledby="idea-title">
			<div className="kd-top">
				<span className="ksw" style={{ background: topic ? topicColor(topic.id) : "var(--faint)" }} />
				<span className="kd-topic trunc">{topic ? displayTopic(topic.name) : "Idea"}</span>
				{concludes && <span className="pill brand">Conclusion</span>}
				<Hint label="Close" binding="escape" side="bottom">
					<button type="button" className="ib sm kd-x" aria-label="Close" onClick={onClose}>
						<Icon name="close" size="sm" />
					</button>
				</Hint>
			</div>
			<div className="kd-head">
				<h2 id="idea-title" className="kd-title serif">
					{idea.name}
				</h2>
				<p className="kd-stmt serif">{idea.statement}</p>
			</div>
			<Related title="Rests on" ids={neighbours.restsOn} empty="A starting point: nothing comes before it." byId={byId} topicOf={topicOf} onPick={onPick} />
			<Related title="Leads to" ids={neighbours.leadsTo} empty="Nothing yet. A good place to go deeper." byId={byId} topicOf={topicOf} onPick={onPick} />
			<dl className="kd-facts">
				<div>
					<dt>Learned</dt>
					<dd className="trunc" title={learnedIn ?? undefined}>
						{[learnedIn, now ? ago(idea.createdAt, now) : null].filter(Boolean).join(" · ") || "—"}
					</dd>
				</div>
				<div>
					<dt>Practice</dt>
					<dd>{topicPracticedAt && now ? `Topic practised ${ago(topicPracticedAt, now)}` : "Not yet"}</dd>
				</div>
			</dl>
			<div className="kd-actions">
				<button type="button" className={`ghost sm ${inTray ? "on" : ""}`} aria-pressed={inTray} onClick={onTray}>
					<Icon name={inTray ? "check" : "plus"} size="sm" />
					{inTray ? "In practice tray" : "Add to practice"}
				</button>
				<button
					type="button"
					className="btn sm"
					onClick={() => window.dispatchEvent(new CustomEvent("lh:open-omnibar", { detail: { query: idea.name } }))}
				>
					Go deeper
					<Icon name="arrow-right" size="sm" />
				</button>
			</div>
		</aside>
	);
}

function Related({
	title,
	ids,
	empty,
	byId,
	topicOf,
	onPick,
}: {
	title: string;
	ids: string[];
	empty: string;
	byId: ReadonlyMap<string, GraphNode>;
	topicOf: ReadonlyMap<string, { id: string; name: string }>;
	onPick: (id: string) => void;
}) {
	const [all, setAll] = useState(false);
	const shown = all ? ids : ids.slice(0, NEIGHBOUR_LIMIT);
	let body: ReactNode;
	if (ids.length === 0) body = <p className="kd-empty">{empty}</p>;
	else
		body = (
			<>
				{shown.map((id) => {
					const t = topicOf.get(id);
					return (
						<button key={id} type="button" className="nlink" onClick={() => onPick(id)}>
							<span className="nlink-dot" style={{ background: t ? topicColor(t.id) : "var(--faint)" }} />
							<span className="nlink-l">{byId.get(id)?.name ?? id}</span>
							<Icon name="chevron-right" size="sm" className="nlink-go" />
						</button>
					);
				})}
				{ids.length > NEIGHBOUR_LIMIT && (
					<button type="button" className="kd-more" onClick={() => setAll((v) => !v)}>
						{all ? "Show fewer" : `Show ${ids.length - NEIGHBOUR_LIMIT} more`}
					</button>
				)}
			</>
		);
	return (
		<section className="kd-sec" aria-label={title}>
			<div className="kd-sec-h">
				<span className="over">{title}</span>
				{ids.length > 0 && <span className="kd-n mono num">{ids.length}</span>}
			</div>
			{body}
		</section>
	);
}
