import * as fs from "node:fs";
import * as path from "node:path";
import { PATHS } from "../../config.ts";
import {
	beatSecondsByChat,
	buildStats,
	callTokens,
	chatProgressOf,
	chatStateOf,
	clampBeatSeconds,
	dailyStats,
	graphContextIdsOf,
	topicsOf,
	type UsagePart,
} from "../core/activity.ts";
import type {
	CallUsage,
	ChatListItem,
	ChatRecord,
	DailyStatsResponse,
	ExtractionRunUsage,
	StatsPeriod,
	StatsResponse,
	Topic,
} from "../core/contracts.ts";
import { timeLedger } from "../store/time-ledger.ts";
import { compactionInFlight } from "./compaction.ts";
import { graphView } from "./graph.ts";
import { jobCost, turnCost } from "./pricing.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import { suggestionUsageParts } from "./suggestions.ts";

function chatExists(chatId: string): boolean {
	if (!/^[A-Za-z0-9_-]+$/.test(chatId)) return false;
	return fs.existsSync(path.join(PATHS.chats, `${chatId}.json`));
}

export function recordTimeBeat(chatId: string, seconds: number, now: Date = new Date()): boolean {
	const credit = clampBeatSeconds(seconds);
	if (credit <= 0 || !chatExists(chatId)) return false;
	timeLedger.appendBeat({ chatId, at: now.toISOString(), seconds: credit });
	return true;
}

export function chatListItems(): ChatListItem[] {
	const minutes = beatSecondsByChat(timeLedger.readBeats());
	return stores.chatStore.listChats().map(({ progress, ...summary }) => {
		const busy = isTurnRunning(summary.id);
		const p = progress ?? chatProgressOf({ kind: summary.kind, messages: [] });
		return {
			...summary,
			busy,
			compacting: compactionInFlight(summary.id),
			state: chatStateOf(p, busy),
			pendingQuestionText: p.pendingQuestionText,
			plan: p.plan,
			minutes: Math.round((minutes.get(summary.id) ?? 0) / 60),
			answers: p.answers,
			practiceSet: p.practiceSet,
		};
	});
}

function allRecords(): ChatRecord[] {
	return stores.chatStore
		.listChats()
		.map((s) => stores.chatStore.getChat(s.id))
		.filter((r): r is ChatRecord => r !== null);
}

function stepsPart(at: string, model: string, steps: readonly CallUsage[]): UsagePart {
	return {
		at,
		tokens: steps.reduce((sum, s) => sum + callTokens(s), 0),
		dollars: turnCost({ id: "", messageId: "", at, model, steps: [...steps] }),
	};
}

function extractionParts(run: ExtractionRunUsage): UsagePart[] {
	const stages = run.stages;
	if (!stages) return [];
	return [stages.extractor, stages.auditor]
		.filter((stage) => stage.steps.length > 0)
		.map((stage) => stepsPart(run.at, stage.model, stage.steps));
}

function usageParts(records: readonly ChatRecord[]): UsagePart[] {
	const parts: UsagePart[] = [];
	for (const record of records) {
		for (const turn of record.turns ?? []) parts.push(stepsPart(turn.at, turn.model, turn.steps));
		for (const run of record.extractions ?? []) parts.push(...extractionParts(run));
		for (const job of stores.jobStore.listJobs(record.id)) {
			if (!job.usage || job.usage.steps < 1) continue;
			parts.push({ at: job.createdAt, tokens: callTokens(job.usage), dollars: jobCost(job) });
		}
	}
	for (const source of stores.graphStore.readSources()) {
		for (const run of source.extractions ?? []) parts.push(...extractionParts(run));
	}
	parts.push(...suggestionUsageParts());
	return parts;
}

export function activityStats(period: StatsPeriod, now: Date = new Date()): StatsResponse {
	const records = allRecords();
	return buildStats(
		{
			chats: records.map((r) => ({
				kind: r.kind ?? "teach",
				updatedAt: r.updatedAt,
				messages: r.messages,
				progress: chatProgressOf(r),
			})),
			nodes: stores.graphStore.readNodes(),
			beats: timeLedger.readBeats(),
			usage: usageParts(records),
		},
		period,
		now,
	);
}

export function activityDaily(now: Date = new Date()): DailyStatsResponse {
	return dailyStats(timeLedger.readBeats(), now, effectiveSettings().general.dailyGoalMinutes);
}

export function activityTopics(): Topic[] {
	const snapshot = graphView();
	const practice = stores.chatStore
		.listChats()
		.filter((s) => s.kind === "practice")
		.map((s) => stores.chatStore.getChat(s.id))
		.filter((r): r is ChatRecord => r !== null)
		.map((r) => ({ updatedAt: r.updatedAt, pickedIds: graphContextIdsOf(r.messages) }))
		.filter((p) => p.pickedIds.length > 0);
	return topicsOf({
		clusters: snapshot.clusters,
		propositions: snapshot.propositions,
		sessions: snapshot.sessions,
		fileSources: snapshot.fileSources,
		practice,
	});
}
