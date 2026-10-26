"use client";

/**
 * HOME (v4 redesign, owner 2026-10-26) — the dashboard at "/". The graph
 * moved to /knowledge; home answers the two questions a learner opens the
 * app with: "where was I?" and "what's new in what I know?".
 *
 *   - the omnibar (the same one ⌘K opens): start a lesson or practice set,
 *     or find a session or idea;
 *   - setup, while a session can't start yet;
 *   - Continue: the session waiting on you (or the latest), then the rest
 *     of what is waiting;
 *   - Just added: the newest ideas in the graph;
 *   - one quiet line of counts — no streaks, goals, or cost on this page
 *     (the product principle: ideas and their connections, not ratings).
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRightIcon, DumbbellIcon, FileUpIcon } from "lucide-react";
import { Omnibar } from "@/components/command-palette";
import { useGraphIndex, type IndexedIdea } from "@/components/graph-index";
import { NotesImportErrors, useNotesImport } from "@/components/notes-import";
import { useServerEvent, useServerResync } from "@/components/server-events";
import { SetupDialog } from "@/components/setup-dialog";
import { isWaitingOnYou, timeAgo } from "@/components/sidebar";
import { useStartReadiness } from "@/components/start-session";
import { cn } from "@/lib/utils";
import type { ChatListItem } from "@/src/core";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/** Pure: the time-of-day greeting. Exported for tests. */
export function greeting(now: Date): string {
	const h = now.getHours();
	return h < 5 ? "Good evening." : h < 12 ? "Good morning." : h < 18 ? "Good afternoon." : "Good evening.";
}

/** Pure: what Continue shows — the session waiting on you (else the most
 *  recent), and the other waiting sessions. Exported for tests. */
export function continueModel(chats: readonly ChatListItem[]): { hero: ChatListItem | null; waiting: ChatListItem[] } {
	const waiting = chats.filter((c) => !c.busy && isWaitingOnYou(c));
	const hero = waiting[0] ?? chats[0] ?? null;
	return { hero, waiting: waiting.filter((c) => c !== hero).slice(0, 3) };
}

/** Pure: the counts line. Exported for tests. */
export function knowledgeCounts(ideas: readonly IndexedIdea[], now: Date): { total: number; thisWeek: number } {
	const since = now.getTime() - WEEK_MS;
	return { total: ideas.length, thisWeek: ideas.filter((i) => new Date(i.createdAt).getTime() >= since).length };
}

function useChatList(): ChatListItem[] | null {
	const [chats, setChats] = useState<ChatListItem[] | null>(null);
	const refresh = useCallback(async () => {
		try {
			const res = await fetch("/api/chats", { cache: "no-store" });
			setChats(((await res.json()) as { chats: ChatListItem[] }).chats);
		} catch {
			setChats((prev) => prev ?? []);
		}
	}, []);
	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const schedule = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => void refresh(), 250);
	};
	useServerEvent("chats-changed", schedule);
	useServerEvent("turn-settled", schedule);
	useServerResync(() => void refresh());
	useEffect(() => {
		void refresh();
		return () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		};
	}, [refresh]);
	return chats;
}

export function Home({ initialConfigured }: { initialConfigured: boolean }) {
	const router = useRouter();
	const chats = useChatList();
	const ideas = useGraphIndex();
	const readiness = useStartReadiness(initialConfigured);
	const [setupOpen, setSetupOpen] = useState(false);
	const [omnibarKey, setOmnibarKey] = useState(0);
	const [draft, setDraft] = useState<{ query: string; mode: "teach" | "practice" }>({ query: "", mode: "teach" });
	const notesImport = useNotesImport();
	const fileRef = useRef<HTMLInputElement>(null);

	// Client clock only: the server's render time is not the reader's.
	const [now, setNow] = useState<Date | null>(null);
	useEffect(() => setNow(new Date()), []);

	const { hero, waiting } = useMemo(() => continueModel(chats ?? []), [chats]);
	const recentIdeas = (ideas ?? []).slice(0, 4);
	const counts = now && ideas ? knowledgeCounts(ideas, now) : null;
	const heroWaiting = hero ? isWaitingOnYou(hero) && !hero.busy : false;
	const firstRun = chats !== null && chats.length === 0;

	return (
		<div className="relative h-dvh overflow-y-auto">
			{/* Window-drag strip (merged chrome): a mask FIRST in the DOM —
			    later controls subtract from it (see knowledge-view.tsx). */}
			<div className="lh-drag absolute inset-x-0 top-0 h-13" aria-hidden="true" />

			<main className="mx-auto flex w-full max-w-[70rem] flex-col gap-4 px-8 pb-12 pt-16">
				<section aria-labelledby="home-greeting" className="relative z-10 flex flex-col gap-3">
					<h1 id="home-greeting" className="ml-1 font-prose text-2xl font-medium" suppressHydrationWarning>
						{now ? greeting(now) : " "}{" "}
						<span className="text-muted-foreground">
							{heroWaiting && hero ? `${hero.title} is waiting.` : "What shall we learn?"}
						</span>
					</h1>
					<Omnibar
						key={omnibarKey}
						variant="inline"
						initial={draft}
						ready={readiness.ready}
						onNeedSetup={(next) => {
							setDraft(next);
							setSetupOpen(true);
						}}
						extraActions={
							<>
								<input
									ref={fileRef}
									type="file"
									multiple
									accept=".md,.markdown,.txt"
									className="hidden"
									onChange={(e) => {
										notesImport.onImportFiles(e.target.files);
										e.target.value = "";
									}}
								/>
								<button
									type="button"
									onClick={() => fileRef.current?.click()}
									disabled={notesImport.importing}
									title="Import notes (Markdown or text) — they become ideas your lessons can build on"
									className="flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
								>
									<FileUpIcon className="size-4" aria-hidden />
									{notesImport.importing ? "Importing…" : "Import notes"}
								</button>
							</>
						}
					/>
					<NotesImportErrors errors={notesImport.errors} />
				</section>

				{readiness.configured !== null && !readiness.ready && (
					<section aria-labelledby="home-setup" className="flex flex-wrap items-center gap-4 rounded-2xl border border-border bg-card px-5 py-4" data-testid="home-setup">
						<div className="flex min-w-0 flex-1 flex-col gap-0.5">
							<h2 id="home-setup" className="text-sm font-semibold">
								{readiness.zeroKeys ? "Connect a provider to start" : "Choose your models to start"}
							</h2>
							<p className="text-sm text-muted-foreground">
								LearnHarness runs on your own key: you pay the provider directly, and the key stays on this Mac.
							</p>
						</div>
						<button
							type="button"
							data-testid="setup-cta"
							onClick={() => setSetupOpen(true)}
							className="h-9 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
						>
							{readiness.zeroKeys ? "Add a provider key" : "Set up models"}
						</button>
					</section>
				)}

				{firstRun ? (
					<section aria-labelledby="home-how" className="flex flex-col gap-3 rounded-2xl border border-border bg-card p-5">
						<h2 id="home-how" className="text-sm font-semibold">How a lesson goes</h2>
						<ol className="grid grid-cols-1 gap-px overflow-hidden rounded-xl border border-border bg-border sm:grid-cols-2 lg:grid-cols-4">
							{[
								["Check-in", "A few questions find where your understanding ends."],
								["Your path", "A plan from there to your goal, which adapts as you go."],
								["Lesson", "Predict, read, then explain your thinking, one step at a time."],
								["Practice", "Later, problems that make you recall it without a hint."],
							].map(([title, body]) => (
								<li key={title} className="flex flex-col gap-1 bg-popover p-4">
									<span className="text-sm font-semibold">{title}</span>
									<span className="text-sm text-muted-foreground">{body}</span>
								</li>
							))}
						</ol>
						<p className="text-sm text-muted-foreground">
							What you learn is saved as ideas and the reasoning that links them, so the next lesson starts from what you already know.
						</p>
					</section>
				) : (
					<div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-12">
						<section aria-labelledby="home-continue" className="overflow-hidden rounded-2xl border border-border bg-card lg:col-span-7">
							{hero ? (
								<>
									<Link href={`/chat/${hero.id}`} className="group block px-5 pb-4 pt-4 transition-colors hover:bg-popover" data-testid="home-continue">
										<span className="flex items-center gap-2 text-xs">
											<span className={cn("size-2 rounded-full", heroWaiting ? "bg-warn" : "bg-faint")} aria-hidden />
											<b id="home-continue" className={cn("font-semibold", heroWaiting ? "text-warn" : "text-muted-foreground")}>
												{heroWaiting ? "Continue · waiting on your answer" : "Pick up where you left off"}
											</b>
											<span className="ml-auto text-muted-foreground">{now ? timeAgo(hero.updatedAt, now) : ""}</span>
										</span>
										<span className="mt-2 block font-prose text-xl leading-snug">{hero.title}</span>
										<span className="mt-3 flex items-center gap-3">
											<span className="flex items-center gap-1.5 text-sm text-muted-foreground">
												{(hero.kind ?? "teach") === "practice" && <DumbbellIcon className="size-3.5" aria-hidden />}
												{(hero.kind ?? "teach") === "practice" ? "Practice" : "Lesson"}
											</span>
											<span className="ml-auto flex h-9 items-center gap-1.5 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors group-hover:bg-primary/90">
												Continue <ArrowRightIcon className="size-4 transition-transform group-hover:translate-x-0.5" aria-hidden />
											</span>
										</span>
									</Link>
									{waiting.length > 0 && (
										<ul className="border-t border-border px-3 py-1.5">
											{waiting.map((c) => (
												<li key={c.id}>
													<button
														type="button"
														onClick={() => router.push(`/chat/${c.id}`)}
														className="flex h-9 w-full items-center gap-2.5 rounded-md px-2 text-left text-sm transition-colors hover:bg-accent"
													>
														<span className="size-2 shrink-0 rounded-full bg-warn" aria-hidden />
														<span className="min-w-0 flex-1 truncate font-semibold">{c.title}</span>
														<span className="shrink-0 text-xs text-muted-foreground">{now ? timeAgo(c.updatedAt, now) : ""}</span>
													</button>
												</li>
											))}
										</ul>
									)}
								</>
							) : (
								<p className="p-5 text-sm text-muted-foreground">Loading…</p>
							)}
						</section>

						<section aria-labelledby="home-new" className="flex flex-col rounded-2xl border border-border bg-card px-5 py-4 lg:col-span-5">
							<div className="mb-1 flex items-baseline justify-between">
								<h2 id="home-new" className="text-xs font-semibold text-muted-foreground">Just added to your knowledge</h2>
								<Link href="/knowledge" className="text-xs font-semibold text-brand hover:underline">
									Graph →
								</Link>
							</div>
							{recentIdeas.length === 0 ? (
								<p className="py-2 text-sm text-muted-foreground">Ideas appear here as your lessons are saved to the graph.</p>
							) : (
								<ul className="flex flex-col">
									{recentIdeas.map((idea, i) => (
										<li key={idea.id} className={cn(i > 0 && "border-t border-border")}>
											<Link href={`/knowledge?idea=${encodeURIComponent(idea.id)}`} className="flex flex-col gap-0.5 py-2.5 transition-colors hover:text-brand">
												<span className="font-prose text-[15px] leading-snug">{idea.name}</span>
												<span className="text-xs text-muted-foreground">
													{[idea.source, now ? timeAgo(idea.createdAt, now) : null].filter(Boolean).join(" · ")}
												</span>
											</Link>
										</li>
									))}
								</ul>
							)}
						</section>
					</div>
				)}

				{counts && counts.total > 0 && (
					<Link href="/knowledge" className="ml-1 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted-foreground hover:text-foreground">
						<span>
							<b className="font-semibold text-foreground tabular-nums">{counts.total}</b> ideas in your graph
						</span>
						{counts.thisWeek > 0 && (
							<span>
								<b className="font-semibold text-foreground tabular-nums">+{counts.thisWeek}</b> this week
							</span>
						)}
						{chats && (
							<span>
								<b className="font-semibold text-foreground tabular-nums">{chats.length}</b> sessions
							</span>
						)}
					</Link>
				)}
			</main>

			<SetupDialog
				open={setupOpen}
				onClose={() => setSetupOpen(false)}
				onDone={() => {
					readiness.markConfigured();
					setSetupOpen(false);
					// Save only saves: the words wait in the omnibar.
					setOmnibarKey((k) => k + 1);
				}}
			/>
		</div>
	);
}
