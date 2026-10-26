"use client";

/**
 * HOME — Home4 of the v4 canvas, built to the artboard (rebuild,
 * 2026-10-26): the greeting and the omnibar, "Next from your graph", the
 * learning strip (week / month), Continue with the sessions waiting on
 * you, minutes learning this week against the daily goal, Ready to
 * practice (pick topics to mix), and what was just added to the graph.
 * Every number on the page is the server's (components/v4/data.ts).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { paletteResults, type PaletteRow } from "@/components/command-palette";
import { joinDictation, useDictation } from "@/components/dictation";
import { useGraphIndex, type IndexedIdea } from "@/components/graph-index";
import { ModelControl } from "@/components/model-picker";
import { NotesImportErrors, useNotesImport } from "@/components/notes-import";
import { SetupDialog } from "@/components/setup-dialog";
import { useSettingsDialog } from "@/components/settings/settings-dialog.tsx";
import { createSession, useStartReadiness, type StartPick } from "@/components/start-session";
import {
	ago,
	fmtDuration,
	fmtTokens,
	isPractice,
	sessionState,
	topicColor,
	useChats,
	useDaily,
	useStats,
	useSuggestions,
	useTopics,
	type StatsPeriod,
	type V4Chat,
	type V4Daily,
	type V4Stats,
	type V4Topic,
} from "@/components/v4/data";
import { AttachIcon, CheckIcon, MicIcon } from "@/components/v4/icons";
import { Field, SessionGroups, SidebarCard } from "@/components/v4/shell";

type Mode = "teach" | "practice";

/** Picks ride the practice create as graph context; a cap keeps the
 *  opening prompt bounded however many topics are mixed. */
const PICK_CAP = 40;

/** Pure: the time-of-day greeting. Exported for tests. */
export function greeting(now: Date): string {
	const h = now.getHours();
	return h < 5 ? "Good evening." : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

/** Pure: Continue's hero (the first session waiting on you, else the most
 *  recent) and the other waiting sessions. Exported for tests. */
export function continueModel(chats: readonly V4Chat[]): { hero: V4Chat | null; waiting: V4Chat[] } {
	const waiting = chats.filter((c) => sessionState(c) === "waiting");
	const hero = waiting[0] ?? chats[0] ?? null;
	return { hero, waiting: waiting.filter((c) => c !== hero).slice(0, 3) };
}

/** Pure: the five strip cells (Home4's KPI strip). Exported for tests. */
export function kpiCells(s: V4Stats): Array<{ label: string; value: string; delta: string; up: boolean; sub: string }> {
	const deltaSec = s.time.seconds - s.time.prevSeconds;
	const prev = s.period === "week" ? "vs last week" : "vs last month";
	return [
		{
			label: "Time learning",
			value: fmtDuration(s.time.seconds),
			delta: deltaSec === 0 ? "" : `${deltaSec > 0 ? "+" : "−"}${fmtDuration(Math.abs(deltaSec))}`,
			up: deltaSec > 0,
			sub: prev,
		},
		{ label: "Lessons", value: String(s.lessons.active), delta: "", up: false, sub: `active · ${s.lessons.waiting} waiting on you` },
		{ label: "Ideas learned", value: `+${s.ideas.added}`, delta: "", up: false, sub: `${s.ideas.total} in your graph` },
		{ label: "Practice", value: String(s.practice.problems), delta: "", up: false, sub: `problems · ${s.practice.solid} solid` },
		{
			label: "Tokens",
			value: fmtTokens(s.tokens.total),
			delta: "",
			up: false,
			sub: s.tokens.dollars === null ? "cost unknown" : `≈ $${s.tokens.dollars.toFixed(2)}`,
		},
	];
}

/** Pure: the ideas a topic mix practises (newest first, capped). */
export function mixPicks(topics: readonly V4Topic[], picked: readonly string[], ideas: readonly IndexedIdea[]): StartPick[] {
	const ids = new Set(topics.filter((t) => picked.includes(t.id)).flatMap((t) => t.ideaIds));
	return ideas
		.filter((i) => ids.has(i.id))
		.slice(0, PICK_CAP)
		.map((i) => ({ id: i.id, name: i.name, statement: i.statement }));
}

export function Home({ initialConfigured, initialMode = "teach" }: { initialConfigured: boolean; initialMode?: Mode }) {
	const chats = useChats();
	const ideas = useGraphIndex();
	const readiness = useStartReadiness(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);
	const [now, setNow] = useState<Date | null>(null);
	useEffect(() => setNow(new Date()), []);

	return (
		<div className="v4">
			<Field />
			<div className="shell">
				<SidebarCard knowledgeCount={ideas?.length ?? null}>
					<SessionGroups chats={chats} />
				</SidebarCard>
				<main className="main">
					<div style={{ maxWidth: 1120, margin: "0 auto", display: "flex", flexDirection: "column", gap: 14 }}>
						<HomeOmni now={now} initialMode={initialMode} ready={readiness.ready} onNeedSetup={() => setSetupOpen(true)} />
						{readiness.configured !== null && !readiness.ready && (
							<section className="glass card rise" style={{ display: "flex", alignItems: "center", gap: 16, animationDelay: "40ms" }} data-testid="home-setup">
								<div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 2 }}>
									<b>{readiness.zeroKeys ? "Connect a provider to start" : "Choose your models to start"}</b>
									<span style={{ color: "var(--muted)", fontSize: 12.5 }}>
										LearnHarness runs on your own key: you pay the provider directly, and the key stays on this Mac.
									</span>
								</div>
								<button type="button" className="btn" data-testid="setup-cta" onClick={() => setSetupOpen(true)}>
									{readiness.zeroKeys ? "Add a provider key" : "Set up models"}
								</button>
							</section>
						)}
						<StatsStrip />
						<div className="g" style={{ display: "grid", gridTemplateColumns: "repeat(12, minmax(0, 1fr))", gap: 14 }}>
							<ContinueCard chats={chats} now={now} />
							<MinutesCard />
							<ReadyToPractice ideas={ideas ?? []} ready={readiness.ready} onNeedSetup={() => setSetupOpen(true)} now={now} />
							<JustAdded ideas={ideas} now={now} />
						</div>
					</div>
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

// ─── The omnibar ──────────────────────────────────────────────────────────

function HomeOmni({ now, initialMode, ready, onNeedSetup }: { now: Date | null; initialMode: Mode; ready: boolean; onNeedSetup: () => void }) {
	const router = useRouter();
	const { open: openSettings } = useSettingsDialog();
	const chats = useChats();
	const ideas = useGraphIndex();
	const suggestions = useSuggestions();
	const [q, setQ] = useState("");
	const qRef = useRef("");
	const [mode, setMode] = useState<Mode>(initialMode);
	const [walk, setWalk] = useState(0);
	const [focused, setFocused] = useState(false);
	const [busy, setBusy] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const fileRef = useRef<HTMLInputElement>(null);
	const notesImport = useNotesImport();
	const setQuery = useCallback((v: string) => {
		qRef.current = v;
		setQ(v);
		setWalk(0);
	}, []);
	const dictation = useDictation({ append: (t) => setQuery(joinDictation(qRef.current, t)) });

	// Query → results: the same model as ⌘K, minus the empty-query lists.
	const groups = useMemo(
		() => (q.trim() ? paletteResults(q, mode, chats ?? [], ideas ?? []) : []),
		[q, mode, chats, ideas],
	);
	const rows = useMemo(() => groups.flatMap((g) => g.rows), [groups]);
	const open = focused && rows.length > 0;
	const active = Math.min(walk, Math.max(0, rows.length - 1));

	// ⌘N (new lesson) and the rail's "+" land here: focus the field.
	useEffect(() => {
		const on = () => inputRef.current?.focus();
		window.addEventListener("lh:focus-omnibar", on);
		return () => window.removeEventListener("lh:focus-omnibar", on);
	}, []);

	const start = async (text: string, as: Mode) => {
		if (!text.trim() || busy) return;
		if (!ready) return onNeedSetup();
		setBusy(true);
		try {
			router.push(await createSession(text, as));
		} catch {
			setBusy(false);
		}
	};
	const run = (row: PaletteRow | undefined) => {
		if (!row) return;
		const a = row.action;
		if (a.kind === "start") void start(a.text, a.mode);
		else if (a.kind === "open-session") router.push(`/chat/${a.id}`);
		else if (a.kind === "open-idea") router.push(`/knowledge?idea=${encodeURIComponent(a.id)}`);
		else if (a.kind === "route") router.push(a.href);
		else openSettings();
	};
	const submit = () => {
		const go = () => (open ? run(rows[active]) : void start(qRef.current, mode));
		if (dictation.active) void dictation.finish().then(go);
		else go();
	};

	let index = -1;
	return (
		<section className="rise" aria-labelledby="greet" style={{ display: "flex", flexDirection: "column", gap: 10, position: "relative", zIndex: 10 }}>
			<h1 id="greet" className="serif" style={{ margin: "0 0 0 4px", fontSize: 22, lineHeight: "28px", fontWeight: 500 }} suppressHydrationWarning>
				{now ? greeting(now) : " "} <span style={{ color: "var(--muted)" }}>What shall we learn?</span>
			</h1>
			<form
				className="omni"
				role="search"
				aria-label="Learn, practice or search"
				onSubmit={(e) => {
					e.preventDefault();
					submit();
				}}
			>
				<label htmlFor="omni" className="sr">Learn, practice or search</label>
				<input
					ref={inputRef}
					id="omni"
					type="text"
					className="serif"
					autoComplete="off"
					spellCheck={false}
					value={q}
					data-testid="home-omnibar"
					onChange={(e) => setQuery(e.target.value)}
					onFocus={() => setFocused(true)}
					onBlur={() => setFocused(false)}
					onKeyDown={(e) => {
						if ((e.key === "ArrowDown" || e.key === "ArrowUp") && open) {
							e.preventDefault();
							const n = rows.length;
							setWalk((i) => (Math.min(i, n - 1) + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
						} else if (e.key === "Escape") {
							e.stopPropagation();
							if (dictation.active) dictation.cancel();
							else if (q) setQuery("");
							else e.currentTarget.blur();
						}
					}}
					placeholder={mode === "teach" ? "Learn anything, or search your sessions and ideas…" : "Practice a topic, or leave it blank for a mix…"}
					style={{ width: "100%", height: 52, border: 0, background: "transparent", outline: "none", fontSize: 19 }}
				/>
				<div style={{ display: "flex", alignItems: "center", gap: 4, flexWrap: "wrap" }}>
					<div className="seg" role="radiogroup" aria-label="Mode">
						{(["teach", "practice"] as const).map((m) => (
							<button key={m} type="button" role="radio" aria-checked={mode === m} className={mode === m ? "on" : ""} onClick={() => setMode(m)} data-testid={`omnibar-mode-${m}`}>
								{m === "teach" ? "Learn" : "Practice"}
							</button>
						))}
					</div>
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
					<button type="button" className="ib" aria-label="Import notes (Markdown or text)" title="Import notes (Markdown or text)" disabled={notesImport.importing} onClick={() => fileRef.current?.click()}>
						<AttachIcon />
					</button>
					<button
						type="button"
						className={`ib ${dictation.active ? "on" : ""}`}
						aria-label={dictation.active ? "Stop dictation" : "Dictate"}
						aria-pressed={dictation.active}
						onClick={() => (dictation.active ? void dictation.finish() : dictation.toggle())}
					>
						{dictation.active ? (
							<span className="wave" aria-hidden="true"><i /><i /><i /><i /></span>
						) : (
							<MicIcon />
						)}
					</button>
					<span className="hide-sm">
						<ModelControl variant="chip" className="mini" />
					</span>
					<span className="hide-sm" style={{ marginLeft: "auto", fontSize: 11.5, color: "var(--faint)" }}>
						<span className="kbd">⌘K</span> from anywhere
					</span>
					<button type="submit" className="btn" style={{ marginLeft: 8 }} disabled={busy}>
						{mode === "teach" ? "Learn" : "Practice"} <span aria-hidden="true">→</span>
					</button>
				</div>
				{open && (
					<div className="drop pop settle" role="listbox" aria-label="Suggestions">
						{groups.map((g) => (
							<div key={g.name}>
								<div style={{ padding: "8px 16px 2px", fontSize: 11, fontWeight: 700, color: "var(--faint)" }}>{g.name}</div>
								{g.rows.map((row) => {
									index += 1;
									const i = index;
									return (
										<button
											key={row.key}
											type="button"
											role="option"
											aria-selected={i === active}
											className={`prow ${i === active ? "first" : ""}`}
											onMouseDown={(e) => e.preventDefault()}
											onMouseMove={() => setWalk(i)}
											onClick={() => run(row)}
										>
											<span className="dot" style={{ background: rowDot(row) }} />
											<span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{row.label}</span>
											<span style={{ fontSize: 11.5, color: "var(--muted)" }}>{row.hint}</span>
										</button>
									);
								})}
							</div>
						))}
					</div>
				)}
			</form>
			<NotesImportErrors errors={notesImport.errors} />
			{suggestions.length > 0 && (
				<div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", paddingLeft: 4 }}>
					<span style={{ fontSize: 12, color: "var(--faint)" }}>Next from your graph</span>
					{suggestions.slice(0, 3).map((s, i) => (
						<button
							key={s.title}
							type="button"
							className={`sug ${i === 2 ? "hide-sm" : ""}`}
							title={s.reason}
							onClick={() => {
								setQuery(s.title);
								setMode("teach");
								inputRef.current?.focus();
							}}
						>
							{s.title}
						</button>
					))}
				</div>
			)}
		</section>
	);
}

function rowDot(row: PaletteRow): string {
	if (row.icon === "learn") return "var(--ink)";
	if (row.icon === "idea") return "#2f8f7f";
	if (row.icon === "graph" || row.icon === "settings") return "var(--accent)";
	if (row.hint === "waiting on you") return "var(--warn)";
	return "var(--faint)";
}

// ─── The learning strip ───────────────────────────────────────────────────

function StatsStrip() {
	const [period, setPeriod] = useState<StatsPeriod>("week");
	const stats = useStats(period);
	const cells = stats ? kpiCells(stats) : null;
	return (
		<section className="glass rise" aria-labelledby="usage" style={{ borderRadius: 16, display: "flex", alignItems: "stretch", animationDelay: "60ms" }}>
			<h2 id="usage" className="sr">Your learning</h2>
			<div className="strip" style={{ flex: 1, display: "grid", gridTemplateColumns: "repeat(5, minmax(0, 1fr))" }}>
				{(cells ?? Array.from({ length: 5 }, () => null)).map((k, i) => (
					<div key={`${period}-${i}`} className="kpi swap">
						<span className="l">{k?.label ?? " "}</span>
						<span className="v num">{k?.value ?? "—"}</span>
						<span className="s">
							{k?.delta && <span className={k.up ? "up" : ""}>{k.delta}</span>} {k?.sub ?? " "}
						</span>
					</div>
				))}
			</div>
			<div style={{ display: "flex", alignItems: "center", padding: "0 12px", borderLeft: "1px solid var(--line)" }}>
				<div className="seg" role="radiogroup" aria-label="Period" style={{ flexDirection: "column", width: 72 }}>
					{(["week", "month"] as const).map((p) => (
						<button key={p} type="button" role="radio" aria-checked={period === p} className={period === p ? "on" : ""} onClick={() => setPeriod(p)}>
							{p === "week" ? "Week" : "Month"}
						</button>
					))}
				</div>
			</div>
		</section>
	);
}

// ─── Continue ─────────────────────────────────────────────────────────────

function Ticks({ total, current, visited, size }: { total: number; current: number | null; visited: number; size?: "lg" }) {
	return (
		<span className={`ticks ${size ?? ""}`} role="img" aria-label={`${visited} of ${total} steps visited`}>
			{Array.from({ length: total }, (_, i) => (
				<i key={i} className={current !== null && i + 1 === current ? "c" : i < visited ? "d" : ""} />
			))}
		</span>
	);
}

function ContinueCard({ chats, now }: { chats: V4Chat[] | null; now: Date | null }) {
	const { hero, waiting } = useMemo(() => continueModel(chats ?? []), [chats]);
	const heroWaiting = hero ? sessionState(hero) === "waiting" : false;
	return (
		<section className="glass rise" aria-labelledby="cont" style={{ gridColumn: "span 7", borderRadius: 16, overflow: "hidden", animationDelay: "120ms" }}>
			{!hero ? (
				<div className="card" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
					<h2 id="cont" className="h">Continue</h2>
					<span style={{ color: "var(--muted)" }}>{chats === null ? "Loading…" : "Your lessons appear here. Start one above."}</span>
				</div>
			) : (
				<>
					<Link className="hero" href={`/chat/${hero.id}`} style={{ padding: "14px 16px 12px" }} data-testid="home-continue">
						<span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11.5 }}>
							<span className="dot" style={{ background: heroWaiting ? "var(--warn)" : "var(--faint)" }} />
							<b id="cont" style={{ color: heroWaiting ? "var(--warn)" : "var(--muted)", fontWeight: 700 }}>
								{heroWaiting ? `Continue · waiting on your ${isPractice(hero) ? "working" : "answer"}` : "Pick up where you left off"}
							</b>
							<span style={{ marginLeft: "auto", color: "var(--muted)" }}>{now ? ago(hero.updatedAt, now) : ""}</span>
						</span>
						<span style={{ display: "block", marginTop: 6, fontWeight: 700 }}>
							{hero.title}
							{hero.plan && hero.plan.current !== null && (
								<span style={{ fontWeight: 500, color: "var(--muted)" }}>
									{" "}
									· step {hero.plan.current} of {hero.plan.total}
								</span>
							)}
							{hero.practiceSet && (
								<span style={{ fontWeight: 500, color: "var(--muted)" }}>
									{" "}
									· problem {Math.min(hero.practiceSet.done + 1, hero.practiceSet.size)} of {hero.practiceSet.size}
								</span>
							)}
						</span>
						{hero.pendingQuestionText && (
							<span className="serif" style={{ display: "block", fontSize: 19, lineHeight: "26px" }}>
								{hero.pendingQuestionText}
							</span>
						)}
						<span style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10 }}>
							{hero.plan && <Ticks total={hero.plan.total} current={hero.plan.current} visited={hero.plan.visited} />}
							<span className="hide-sm" style={{ fontSize: 11.5, color: "var(--muted)" }}>
								{[
									hero.minutes ? `${hero.minutes} min in` : null,
									hero.answers && hero.answers.total > 0 ? `${hero.answers.firstTry} of ${hero.answers.total} right first time` : null,
								]
									.filter(Boolean)
									.join(" · ")}
							</span>
							<span className="btn" style={{ marginLeft: "auto" }}>
								Continue <span className="go" aria-hidden="true">→</span>
							</span>
						</span>
					</Link>
					{waiting.length > 0 && (
						<div style={{ padding: "2px 16px 8px", borderTop: "1px solid var(--line)" }}>
							{waiting.map((c) => (
								<Link key={c.id} className="wrow" href={`/chat/${c.id}`}>
									<span className="dot" style={{ background: "var(--warn)" }} />
									<b style={{ fontWeight: 600, whiteSpace: "nowrap" }}>{c.title}</b>
									<span className="serif" style={{ flex: 1, minWidth: 0, color: "var(--muted)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
										{c.pendingQuestionText ?? ""}
									</span>
									<span style={{ fontSize: 11.5, color: "var(--faint)", whiteSpace: "nowrap" }}>
										{c.plan && c.plan.current !== null ? `${c.plan.current} of ${c.plan.total}` : isPractice(c) ? "practice" : "check-in"}
									</span>
								</Link>
							))}
						</div>
					)}
				</>
			)}
		</section>
	);
}

// ─── Minutes this week ────────────────────────────────────────────────────

/** Pure: bar heights as % of the week's busiest day (min 100 minutes or
 *  the goal, so a light week doesn't fill the chart). Exported for tests. */
export function barHeights(daily: V4Daily): number[] {
	const top = Math.max(...daily.days.map((d) => d.minutes), daily.goalMinutes * 1.5, 1);
	return daily.days.map((d) => Math.round((d.minutes / top) * 100));
}

function MinutesCard() {
	const daily = useDaily();
	const heights = daily ? barHeights(daily) : null;
	const goalPct = daily ? Math.round((daily.goalMinutes / Math.max(...daily.days.map((d) => d.minutes), daily.goalMinutes * 1.5, 1)) * 100) : 50;
	const todayIdx = daily?.days.findIndex((d) => d.today) ?? -1;
	const label = daily
		? `Minutes learning per day this week: ${daily.days.map((d) => `${d.label} ${d.minutes}`).join(", ")}. Goal ${daily.goalMinutes} a day, met on ${daily.metDays} days.`
		: "Minutes learning this week";
	return (
		<section className="glass card rise" aria-labelledby="mins" style={{ gridColumn: "span 5", display: "flex", flexDirection: "column", gap: 8, animationDelay: "160ms" }}>
			<div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
				<h2 id="mins" className="h">Minutes learning, this week</h2>
				{daily && (
					<span style={{ fontSize: 11.5, color: "var(--muted)" }}>
						goal {daily.goalMinutes} · met {daily.metDays} of {Math.max(1, todayIdx + 1)}
					</span>
				)}
			</div>
			<div className="bars" role="img" aria-label={label}>
				<span aria-hidden="true" style={{ position: "absolute", left: 0, right: 0, bottom: `${goalPct}%`, borderTop: "1px dashed var(--line2)" }} />
				{(daily?.days ?? Array.from({ length: 7 }, () => null)).map((d, i) => (
					<div key={i} className={`bar ${d?.today ? "today" : ""}`}>
						<b>{d && (i <= todayIdx || todayIdx === -1) ? d.minutes : ""}</b>
						<i style={{ height: `${heights?.[i] ?? 0}%`, animationDelay: `${200 + i * 40}ms` }} />
					</div>
				))}
			</div>
			<div style={{ display: "grid", gridTemplateColumns: "repeat(7, minmax(0, 1fr))", gap: 8, textAlign: "center", fontSize: 11, color: "var(--faint)" }}>
				{(daily?.days ?? ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => ({ label, today: false }))).map((d) => (
					<span key={d.label} style={d.today ? { color: "var(--accent)", fontWeight: 700 } : undefined}>
						{d.today ? "Today" : d.label}
					</span>
				))}
			</div>
		</section>
	);
}

// ─── Ready to practice ────────────────────────────────────────────────────

function ReadyToPractice({ ideas, ready, onNeedSetup, now }: { ideas: IndexedIdea[]; ready: boolean; onNeedSetup: () => void; now: Date | null }) {
	const router = useRouter();
	const topics = useTopics();
	const [picked, setPicked] = useState<string[]>([]);
	const [busy, setBusy] = useState(false);
	// The four topics that most want practice: never practised first, then
	// the longest since practice.
	const shown = useMemo(
		() =>
			[...(topics ?? [])]
				.sort((a, b) => (a.lastPracticedAt ?? "").localeCompare(b.lastPracticedAt ?? ""))
				.slice(0, 4),
		[topics],
	);
	const picks = useMemo(() => mixPicks(shown, picked, ideas), [shown, picked, ideas]);
	const ideaCount = shown.filter((t) => picked.includes(t.id)).reduce((n, t) => n + t.ideaIds.length, 0);
	const note =
		picked.length === 0 ? "Nothing picked: a mix of everything" : `${picked.length} picked · ${ideaCount} ideas · about ${Math.max(10, Math.round(ideaCount * 0.8))} min`;

	const start = async () => {
		if (busy) return;
		if (!ready) return onNeedSetup();
		setBusy(true);
		const names = shown.filter((t) => picked.includes(t.id)).map((t) => t.name);
		const title = names.length ? `Practice: ${names.join(", ")}` : "Practice: a mix of everything";
		try {
			router.push(await createSession(title, "practice", picks));
		} catch {
			setBusy(false);
		}
	};

	return (
		<section className="glass card rise" aria-labelledby="ready" style={{ gridColumn: "span 7", display: "flex", flexDirection: "column", gap: 8, animationDelay: "200ms" }}>
			<div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
				<h2 id="ready" className="h">Ready to practice</h2>
				<span style={{ fontSize: 11.5, color: "var(--faint)" }}>pick to mix</span>
			</div>
			{shown.length === 0 ? (
				<span style={{ color: "var(--muted)", padding: "6px 0" }}>{topics === null ? "Loading…" : "Topics appear here once your lessons are saved to the graph."}</span>
			) : (
				<div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 6 }}>
					{shown.map((t) => {
						const on = picked.includes(t.id);
						return (
							<button
								key={t.id}
								type="button"
								role="checkbox"
								aria-checked={on}
								className={`pick ${on ? "on" : ""}`}
								onClick={() => setPicked((p) => (on ? p.filter((x) => x !== t.id) : [...p, t.id]))}
							>
								<span className="box" aria-hidden="true">
									<CheckIcon size={10} />
								</span>
								<span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
									<b style={{ fontWeight: 600, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</b>
									<span style={{ fontSize: 11.5, color: "var(--muted)" }}>
										{t.ideaIds.length} ideas · {t.lastPracticedAt ? (now ? ago(t.lastPracticedAt, now) : "") : "never practiced"}
									</span>
								</span>
							</button>
						);
					})}
				</div>
			)}
			<div style={{ display: "flex", alignItems: "center", gap: 10 }}>
				<span style={{ fontSize: 12, color: "var(--muted)" }}>{note}</span>
				<button type="button" className="btn" style={{ marginLeft: "auto" }} disabled={busy} onClick={() => void start()}>
					{picked.length > 1 ? `Practice these ${picked.length}` : "Start practice"}
				</button>
			</div>
		</section>
	);
}

// ─── Just added ───────────────────────────────────────────────────────────

function JustAdded({ ideas, now }: { ideas: IndexedIdea[] | null; now: Date | null }) {
	const topics = useTopics();
	const topicOf = useMemo(() => {
		const m = new Map<string, V4Topic>();
		for (const t of topics ?? []) for (const id of t.ideaIds) m.set(id, t);
		return m;
	}, [topics]);
	const week = now ? (ideas ?? []).filter((i) => now.getTime() - new Date(i.createdAt).getTime() < 7 * 86_400_000).length : 0;
	const shown = (ideas ?? []).slice(0, 2);
	return (
		<section className="glass card rise" aria-labelledby="new" style={{ gridColumn: "span 5", display: "flex", flexDirection: "column", gap: 2, animationDelay: "240ms" }}>
			<div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 2 }}>
				<h2 id="new" className="h">Just added to your knowledge</h2>
				<Link href="/knowledge" style={{ fontSize: 12, fontWeight: 600, color: "var(--accent)" }}>
					Graph →
				</Link>
			</div>
			{shown.length === 0 && <span style={{ color: "var(--muted)", padding: "6px 0" }}>{ideas === null ? "Loading…" : "Ideas appear here as your lessons are saved."}</span>}
			{shown.map((idea, i) => {
				const topic = topicOf.get(idea.id);
				const more = i === shown.length - 1 && week > shown.length ? ` · +${week - shown.length} more this week` : "";
				return (
					<Link key={idea.id} className="idea" href={`/knowledge?idea=${encodeURIComponent(idea.id)}`}>
						<span className="dot" style={{ marginTop: 7, background: topic ? topicColor(topic.id) : "#2f8f7f" }} />
						<span style={{ display: "flex", flexDirection: "column" }}>
							<span className="serif" style={{ fontSize: 14, lineHeight: "20px" }} title={idea.statement}>
								{idea.name}
							</span>
							<span style={{ fontSize: 11, color: "var(--faint)" }}>
								{[topic?.name ?? idea.source, now ? ago(idea.createdAt, now) : null].filter(Boolean).join(" · ")}
								{more}
							</span>
						</span>
					</Link>
				);
			})}
		</section>
	);
}
