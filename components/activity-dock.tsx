"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIcon, BotIcon, FileTextIcon, PenToolIcon, PlayIcon, SearchIcon, SquareIcon, WaypointsIcon } from "lucide-react";
import { cn } from "@/lib/utils";
import type { CallUsage, JobKind, JobRecord } from "@/src/core";
import { isModelsRefusal, isProviderKeyRefusal, subscriptionLabel, subscriptionLabels } from "@/src/core";
import { formatTokens, planCostLabel } from "@/components/usage-format";
import { useServerEvent, useServerResync } from "@/components/server-events";

interface FeedUsage extends NonNullable<JobRecord["usage"]> {
	lastStep?: CallUsage;
}

export interface FeedJob extends JobRecord {
	costUsd?: number | null;
	title: string;
	usage?: FeedUsage;
	contextLimit: number | null;
}

export interface FeedExtraction {
	id: string;
	chatId: string;
	part?: { i: number; n: number };
	title: string;
	phase: string;
	startedAt: number;
}

export interface ActivityFeed {
	jobs: FeedJob[];
	extractions: FeedExtraction[];
}

const EMPTY_FEED: ActivityFeed = { jobs: [], extractions: [] };

const ActivityContext = createContext<{ feed: ActivityFeed; refresh: () => void }>({
	feed: EMPTY_FEED,
	refresh: () => {},
});

export function ActivityProvider({ children }: { children: React.ReactNode }) {
	const [feed, setFeed] = useState<ActivityFeed>(EMPTY_FEED);
	const [nonce, setNonce] = useState(0);
	const refresh = useCallback(() => setNonce((n) => n + 1), []);
	const refreshRef = useRef(refresh);
	refreshRef.current = refresh;
	const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	useEffect(() => {
		let alive = true;
		void (async () => {
			try {
				const res = await fetch("/api/activity");
				if (res.ok) {
					const data = (await res.json()) as Partial<ActivityFeed>;
					if (alive)
						setFeed({ jobs: data.jobs ?? [], extractions: data.extractions ?? [] });
				}
			} catch {
				// transport blip: keep the last feed, announce again next event
			}
		})();
		return () => {
			alive = false;
		};
	}, [nonce]);

	const scheduleAnnouncedFetch = () => {
		if (debounceRef.current) clearTimeout(debounceRef.current);
		debounceRef.current = setTimeout(() => {
			debounceRef.current = undefined;
			refreshRef.current();
		}, 250);
	};
	useServerEvent("activity-changed", scheduleAnnouncedFetch);
	useServerEvent("jobs-changed", scheduleAnnouncedFetch);
	useServerResync(() => refreshRef.current());

	useEffect(() => {
		const onVisibility = () => {
			if (document.visibilityState === "visible") setNonce((n) => n + 1);
		};
		document.addEventListener("visibilitychange", onVisibility);
		return () => document.removeEventListener("visibilitychange", onVisibility);
	}, []);

	useEffect(
		() => () => {
			if (debounceRef.current) clearTimeout(debounceRef.current);
		},
		[],
	);

	return <ActivityContext.Provider value={{ feed, refresh }}>{children}</ActivityContext.Provider>;
}

export function useActivity(): { feed: ActivityFeed; refresh: () => void } {
	return useContext(ActivityContext);
}

export interface ActivityBlob {
	id: string;
	process: "job" | "extraction";
	jobKind?: JobKind;
	phase?: string;
	title: string;
	chatId: string;
	startedAt: number;
	cost: number | null;
	context: { used: number; limit: number } | null;
	activity: string;
	model?: string;
	steps?: number;
}

export function toBlobs(feed: ActivityFeed): ActivityBlob[] {
	const blobs: ActivityBlob[] = feed.jobs.map((job) => {
		const usage = job.usage;
		let context: ActivityBlob["context"] = null;
		const lastStep = usage?.lastStep;
		const limit = job.contextLimit;
		if (usage && lastStep && limit !== null && lastStep.inputTokens !== undefined) {
			context = {
				used:
					lastStep.inputTokens +
					(lastStep.outputTokens ?? 0) +
					(lastStep.cacheReadTokens ?? 0) +
					(lastStep.cacheWriteTokens ?? 0),
				limit,
			};
		}
		return {
			id: job.id,
			process: "job",
			jobKind: job.kind,
			title: job.title,
			chatId: job.chatId,
			startedAt: Date.parse(job.createdAt) || 0,
			cost: job.costUsd ?? null,
			context,
			activity: isModelsRefusal(job.error)
				? "needs model setup"
				: isProviderKeyRefusal(job.error)
					? "needs a provider key"
					: (job.activity ?? ""),
			model: usage?.model,
			steps: usage?.steps,
		};
	});
	for (const run of feed.extractions) {
		blobs.push({
			id: run.id,
			process: "extraction",
			phase: run.phase,
			title: run.title,
			chatId: run.chatId,
			startedAt: run.startedAt,
			cost: null, // extraction runs don't ride the money channel (v1)
			context: null,
			activity: "",
		});
	}
	blobs.sort((a, b) => a.startedAt - b.startedAt);
	return blobs;
}

export function formatElapsed(ms: number): string {
	const s = Math.max(0, Math.floor(ms / 1000));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
	return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function useNow(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		const t = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(t);
	}, [active]);
	return now;
}

const KIND_ICON: Record<JobKind, typeof SearchIcon> = {
	research: SearchIcon,
	demo: PlayIcon,
	visual: PenToolIcon,
	pdf: FileTextIcon, // sources v0 — type-forced entry (JobKind grew "pdf")
};

type AbortState = "pending" | "failed";

export function ActivitySection({ feed: feedProp }: { feed?: ActivityFeed }) {
	const ctx = useContext(ActivityContext);
	const feed = feedProp ?? ctx.feed;
	const refresh = ctx.refresh;
	const blobs = useMemo(() => toBlobs(feed), [feed]);
	const [openBlob, setOpenBlob] = useState<string | null>(null);
	const [abortStates, setAbortStates] = useState<Record<string, AbortState>>({});
	const now = useNow(blobs.length > 0);
	const abortRef = useRef({ blobs, refresh, setAbortStates });
	abortRef.current = { blobs, refresh, setAbortStates };

	const totalCost = useMemo(() => {
		const priced = blobs.map((b) => b.cost).filter((c): c is number => c !== null);
		return priced.length === 0 ? null : priced.reduce((a, c) => a + c, 0);
	}, [blobs]);

	const abort = useCallback(async (blob: ActivityBlob) => {
		const { setAbortStates: set } = abortRef.current;
		set((s) => ({ ...s, [blob.id]: "pending" }));
		try {
			const res = await fetch("/api/activity/abort", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					kind: blob.process,
					id: blob.process === "extraction" ? blob.chatId : blob.id,
				}),
			});
			if (!res.ok) {
				if (res.status === 404 || res.status === 409) {
					abortRef.current.refresh();
					set((s) => {
						const { [blob.id]: _drop, ...rest } = s;
						return rest;
					});
					return;
				}
				throw new Error(String(res.status));
			}
			abortRef.current.refresh();
		} catch {
			set((s) => ({ ...s, [blob.id]: "failed" }));
		}
	}, []);

	return (
		<section data-testid="activity-section" className="border-t border-border px-2 pb-2 pt-2">
			<div className="mb-1 flex items-center gap-1.5 px-2.5 text-xs font-semibold text-faint">
				<ActivityIcon className="size-3.5" />
				Background agents
				{blobs.length > 0 && (
					<span className="ml-auto tabular-nums" data-testid="activity-total-cost" title="Total running cost (inferred)">
						{planCostLabel(totalCost, subscriptionLabels(blobs.map((blob) => blob.model)))}
				</span>
				)}
			</div>
			{blobs.length > 0 && (
				<div className="flex max-h-[40dvh] flex-col gap-1 overflow-y-auto">
					{blobs.map((blob) => (
						<ActivityBlobRow
							key={blob.id}
							blob={blob}
							now={now}
							detailOpen={openBlob === blob.id}
							onToggleDetail={() => setOpenBlob((id) => (id === blob.id ? null : blob.id))}
							abortState={abortStates[blob.id]}
							onAbort={() => void abort(blob)}
						/>
					))}
			</div>
			)}
		</section>
	);
}

function ActivityBlobRow({
	blob,
	now,
	detailOpen,
	onToggleDetail,
	abortState,
	onAbort,
}: {
	blob: ActivityBlob;
	now: number;
	detailOpen: boolean;
	onToggleDetail: () => void;
	abortState: AbortState | undefined;
	onAbort: () => void;
}) {
	const Icon = blob.process === "extraction" ? WaypointsIcon : (blob.jobKind && KIND_ICON[blob.jobKind]) || BotIcon;
	const label =
		blob.process === "extraction"
			? `Extraction — ${blob.phase ?? "running"}`
			: blob.jobKind === "research"
				? "Researcher"
				: blob.jobKind === "demo"
					? "Demo builder"
					: blob.jobKind === "visual"
						? "Figure maker"
						: blob.jobKind === "pdf"
							? "PDF reader"
							: "Sub-agent";
	return (
		<div
			data-testid={`activity-blob-${blob.process}`}
			className="relative rounded-lg px-2 py-1.5 text-xs transition-colors hover:bg-accent"
		>
			<button
				type="button"
				onClick={onToggleDetail}
				aria-expanded={detailOpen}
				className="flex w-full items-center gap-2 pr-7 text-left"
			>
				<Icon className="size-3.5 shrink-0 text-muted-foreground" />
				<span className="min-w-0 flex-1">
					<span className="block truncate font-medium text-card-foreground">{blob.title}</span>
					{blob.activity ? (
						<span className="block truncate text-muted-foreground" title={blob.activity}>
							{blob.activity}
						</span>
					) : (
						<span className="block truncate text-muted-foreground/80">{label}</span>
					)}
				</span>
				<span className="flex shrink-0 items-center gap-2 tabular-nums text-muted-foreground">
					<span data-testid="activity-blob-cost">{planCostLabel(blob.cost, subscriptionLabel(blob.model))}</span>
					<span data-testid="activity-blob-elapsed">{formatElapsed(now - blob.startedAt)}</span>
				</span>
			</button>
			<button
				type="button"
				data-testid="activity-abort"
				onClick={onAbort}
				disabled={abortState !== undefined}
				title={abortState === "failed" ? "Abort failed — try again" : "End this background process"}
				aria-label={`End ${label} in ${blob.title}`}
				className="absolute right-1 top-1/2 -translate-y-1/2 rounded-md p-1 text-muted-foreground/70 transition-colors hover:bg-destructive/10 hover:text-destructive disabled:opacity-50"
			>
				<SquareIcon className="size-3" />
			</button>

			{detailOpen && (
				<div
					data-testid="activity-blob-detail"
					className="mt-1 flex flex-col gap-1 rounded-lg bg-accent/40 p-2 text-muted-foreground"
				>
					<div className="mb-1.5 flex items-center gap-2">
						<Icon className="size-3.5 text-muted-foreground" />
						<span className="font-medium">{label}</span>
						<span className="ml-auto tabular-nums text-muted-foreground">
							{formatElapsed(now - blob.startedAt)}
						</span>
					</div>
					<div className="flex flex-col gap-1 text-muted-foreground">
						<div className="truncate text-card-foreground" title={blob.title}>
							{blob.title}
						</div>
						{blob.activity && <div className="break-words">{blob.activity}</div>}
						<div className="flex justify-between gap-2">
							<span>Cost</span>
							<span className="tabular-nums text-card-foreground">
								{planCostLabel(blob.cost, subscriptionLabel(blob.model))}
							</span>
						</div>
						<div className="flex justify-between gap-2">
							<span>Context</span>
							<span className="tabular-nums text-card-foreground" data-testid="activity-blob-context">
								{blob.context === null
									? "—"
									: `${formatTokens(blob.context.used)} / ${formatTokens(blob.context.limit)}`}
							</span>
						</div>
						{blob.model && (
							<div className="flex justify-between gap-2">
								<span>Model</span>
								<span className="truncate text-card-foreground">{blob.model}</span>
							</div>
						)}
						{blob.steps !== undefined && (
							<div className="flex justify-between gap-2">
								<span>Steps</span>
								<span className="tabular-nums text-card-foreground">{blob.steps}</span>
							</div>
						)}
						<a href={`/chat/${blob.chatId}`} className="text-primary hover:underline">
							Open session →
						</a>
					</div>
					<div className="mt-2 text-muted-foreground/80">
					{abortState === "failed" && "Abort failed — try again"}
					{abortState === "pending" && "Stopping…"}
				</div>
				</div>
			)}
		</div>
	);
}