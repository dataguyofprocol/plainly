/**
 * All mutable state lives on globalThis: Next dev gives each route entry its
 * own module instances, so a module-level Map would be a different object in each.
 */

import {
	buildAbortSteer,
	buildSubagentSteer,
	isSubagentFailure,
	steerDelivered,
	type JobRecord,
	type SteerMessage,
} from "../core/contracts.ts";
import type { TurnInput } from "../core/input-events.ts";
import { danglingQuestionOf, endsInDismissal, type LhMessage } from "../core/native-messages.ts";
import { fireJobAbort, isJobLive } from "../agent/subagents/aborts.ts";
import { stores, effectiveSettings } from "./stores.ts";
import { resolveConversationSpec } from "../core/settings-resolution.ts";
import { connectionBackgroundAllowed, isSubscriptionProvider, onSubscriptionChange } from "../agent/subscription-connections.ts";
import { isTurnRunning } from "./turn-liveness.ts";
import type { Agent } from "@earendil-works/pi-agent-core";

export type TurnRunner = (chatId: string, input: TurnInput) => Promise<number>;

export type JobRespawn = (jobId: string) => void;

interface QueuedSteer {
	steer: SteerMessage;
	resolve: () => void;
	reject: (reason: Error) => void;
	handedTo?: Agent;
}

interface WakeState {
	turnRunner?: TurnRunner;
	respawn?: JobRespawn;
	queues: Map<string, QueuedSteer[]>;
	userSteers: Map<string, UserSteerEntry[]>;
	liveAgents: Map<string, Agent>;
	pumping: Set<string>;
	lastSweepAt: number;
	stopConnectionWatch?: () => void;
	automaticDeferred: WeakSet<Agent>;
}

interface LhWakeGlobal {
	__lhWakePipeline?: WakeState;
}

function state(): WakeState {
	const g = globalThis as typeof globalThis & LhWakeGlobal;
	return (g.__lhWakePipeline ??= { queues: new Map(), liveAgents: new Map(), userSteers: new Map(), pumping: new Set(), lastSweepAt: 0, automaticDeferred: new WeakSet() });
}

export function setTurnRunner(run: TurnRunner): void {
	state().turnRunner = run;
}

export function setJobRespawn(respawn: JobRespawn): void {
	state().respawn = respawn;
}

const POLL_MS = 400;
const GRACE_MS = 750;
const RETRY_BACKOFF_MS = [500, 1000, 2000, 5000] as const;

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function jobIdOf(steer: SteerMessage): string | null {
	const details = steer.details as { jobId?: string } | undefined;
	return typeof details?.jobId === "string" ? details.jobId : null;
}

export function noteSteerVisible(steer: SteerMessage): void {
	finalizeSteer(steer);
}

function finalizeSteer(steer: SteerMessage): void {
	const jobId = jobIdOf(steer);
	if (jobId) finalizeJob(jobId);
}

function failSteer(steer: SteerMessage, err: Error): void {
	const jobId = jobIdOf(steer);
	if (jobId) failJob(jobId, err);
}

/** Queue ANY steer (result, abort, probe handoff) through the pipeline.
 *  Resolves when the wake turn has completed; rejects when delivery fails
 *  unrecoverably. Never rejects for queueing itself. */
export function deliverJobResult(steer: SteerMessage): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const s = state();
		const chatId = chatIdOf(steer);
		const queue = s.queues.get(chatId) ?? [];
		queue.push({ steer, resolve, reject });
		s.queues.set(chatId, queue);
		void pump(chatId);
	});
}

export function automaticFollowUpAllowed(chatId: string, agent?: Agent): boolean {
	if (agent && state().automaticDeferred.has(agent)) return false;
	const provider = agent?.state?.model?.provider ?? resolveConversationSpec(stores.chatStore.getChat(chatId)?.settings, effectiveSettings().models.strong)?.provider;
	return connectionBackgroundAllowed(provider);
}

function handOffEligible(chatId: string, agent: Agent): void {
	const queue = state().queues.get(chatId);
	if (automaticFollowUpAllowed(chatId, agent) && queue && queue.length > 0) {
		for (const entry of queue) {
			if (entry.handedTo !== agent && entry.steer.customType !== "probe-handoff") {
				agent.steer(entry.steer);
				entry.handedTo = agent;
			}
		}
	}
	const userQueue = state().userSteers.get(chatId);
	if (userQueue && userQueue.length > 0) {
		for (const entry of userQueue) {
			if (entry.handedTo !== agent) {
				agent.steer(entry.message);
				entry.handedTo = agent;
			}
		}
	}
}

/** Call BEFORE runPiTurn: pi's continue() drains the steering queue
 *  synchronously inside that call, so a later registration would miss it. */
export function registerLiveAgent(chatId: string, agent: Agent): void {
	state().liveAgents.set(chatId, agent);
	handOffEligible(chatId, agent);
}

export interface UserSteerEntry {
	message: LhMessage;
	handedTo?: Agent;
}

/** The steer route's live hand-off (composer steering, 2026-10-03).
 *  Synchronous by design — no interleaving between the live-agent check
 *  and the queue() means a settling turn can never race the hand-off.
 *  Returns false when no turn is live: the caller 409s and the client
 *  falls back to a plain text send (the settle race). The registry copy
 *  is the stranding safety net: if this agent dies undelivered (question
 *  termination, abort), reconcileUserSteers keeps it parked for the
 *  chat's next run. */
export function steerLiveChat(chatId: string, message: LhMessage): boolean {
	const agent = state().liveAgents.get(chatId);
	if (!agent) return false;
	const entry: UserSteerEntry = { message };
	const q = state().userSteers.get(chatId) ?? [];
	q.push(entry);
	state().userSteers.set(chatId, q);
	agent.steer(message);
	entry.handedTo = agent;
	return true;
}

export function reconcileUserSteers(chatId: string, persisted: readonly LhMessage[]): void {
	const q = state().userSteers.get(chatId);
	if (!q || q.length === 0) return;
	const ids = new Set(persisted.map((m) => (m as { id?: string }).id));
	const kept = q.filter((e) => !ids.has(e.message.id));
	if (kept.length === 0) state().userSteers.delete(chatId);
	else state().userSteers.set(chatId, kept);
}

export function unregisterLiveAgent(chatId: string): void {
	const agent = state().liveAgents.get(chatId);
	if (agent) state().automaticDeferred.delete(agent);
	state().liveAgents.delete(chatId);
}

export function restoreUncommittedAutomatic(chatId: string, agent: Agent, automaticIds: ReadonlySet<string>, retainedIds: ReadonlySet<string>): void {
	const s = state();
	s.automaticDeferred.add(agent);
	for (const entry of s.queues.get(chatId) ?? []) {
		if (entry.handedTo === agent && automaticIds.has(entry.steer.id)) entry.handedTo = undefined;
	}
	agent.clearSteeringQueue();
	for (const entry of s.userSteers.get(chatId) ?? []) {
		if (!retainedIds.has(entry.message.id)) { agent.steer(entry.message); entry.handedTo = agent; }
	}
}

export function settleSteers(chatId: string, persisted: { id?: string }[]): void {
	const queue = state().queues.get(chatId);
	if (!queue || queue.length === 0) return;
	const deliveredIds = new Set(persisted.map((m) => m.id).filter(Boolean));
	const remaining: QueuedSteer[] = [];
	for (const entry of queue) {
		if (deliveredIds.has(entry.steer.id)) {
			finalizeSteer(entry.steer);
			entry.resolve();
		} else {
			entry.handedTo = undefined;
			remaining.push(entry);
		}
	}
	if (remaining.length === 0) state().queues.delete(chatId);
	else {
		state().queues.set(chatId, remaining);
		void pump(chatId);
	}
}

export interface AbortOutcome {
	ok: boolean;
	reason?: "not_found" | "not_running";
}

export function abortJob(jobId: string): AbortOutcome {
	const job = stores.jobStore.getJob(jobId);
	if (!job) return { ok: false, reason: "not_found" };
	if (job.status !== "running") return { ok: false, reason: "not_running" };

	fireJobAbort(jobId);

	const queue = state().queues.get(job.chatId);
	if (queue) {
		const remaining = queue.filter(
			(e) => jobIdOf(e.steer) !== jobId || e.handedTo !== undefined,
		);
		if (remaining.length === 0) state().queues.delete(job.chatId);
		else state().queues.set(job.chatId, remaining);
		for (const entry of queue) {
			if (jobIdOf(entry.steer) === jobId && entry.handedTo === undefined) entry.resolve();
		}
	}

	stores.jobStore.updateJob(jobId, { status: "error", error: "Aborted by learner", activity: "aborted" });
	void deliverJobResult(buildAbortSteer(job)).catch(() => {
		/* deliverJobResult marks the job error on unrecoverable failure */
	});
	return { ok: true };
}

function chatIdOf(steer: SteerMessage): string {
	if (steer.customType === "probe-handoff") {
		return (steer.details as { chatId: string }).chatId;
	}
	const jobId = jobIdOf(steer);
	const job = jobId ? stores.jobStore.getJob(jobId) : undefined;
	return job?.chatId ?? "";
}

async function pump(chatId: string): Promise<void> {
	if (!chatId) return;
	const s = state();
	if (s.pumping.has(chatId)) return;
	s.pumping.add(chatId);
	let parked = false;
	try {
		for (let attempt = 0; ; ) {
			const queue = s.queues.get(chatId);
			if (!queue || queue.length === 0) {
				s.queues.delete(chatId);
				return;
			}

			const record = stores.chatStore.getChat(chatId);
			if (!record) {
				s.queues.delete(chatId);
				for (const entry of queue) {
					entry.reject(new Error(`chat ${chatId} not found — cannot deliver steer ${entry.steer.id}`));
				}
				continue;
			}

			const stillPending = queue.filter((e) => !steerDelivered(record.messages, e.steer.id));
			for (const entry of queue) {
				if (!stillPending.includes(entry)) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			}
			if (stillPending.length === 0) {
				s.queues.delete(chatId);
				return;
			}
			s.queues.set(chatId, stillPending);
			if (!automaticFollowUpAllowed(chatId, s.liveAgents.get(chatId))) { parked = true; return; }

			const live = s.liveAgents.get(chatId);
			if (live && isTurnRunning(chatId)) {
				handOffEligible(chatId, live);
				const handable = stillPending.filter((e) => e.handedTo === live);
				const handoffWaits = stillPending.some(
					(e) => e.steer.customType === "probe-handoff",
				);
				if (handable.length > 0 && !handoffWaits) {
					return; // the run delivers; settleSteers re-pumps the rest
				}
				if (handable.length > 0) {
					await delay(POLL_MS);
					await waitForIdle(chatId);
					continue;
				}
			}

			await waitForIdle(chatId);

			const fresh = stores.chatStore.getChat(chatId);
			if (!fresh) {
				continue; // the gone-chat branch rejects next iteration
			}

			if (!s.turnRunner) {
				s.queues.delete(chatId);
				const err = new Error("wake pipeline: no turn runner wired (setTurnRunner)");
				for (const entry of stillPending) {
					failSteer(entry.steer, err);
					entry.reject(err);
				}
				return;
			}

			const current = s.queues.get(chatId) ?? [];
			const fire = current.filter((e) => !steerDelivered(fresh.messages, e.steer.id));
			for (const entry of current) {
				if (!fire.includes(entry)) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			}
			if (fire.length === 0) {
				s.queues.delete(chatId);
				return;
			}

			if (endsInDismissal(fresh.messages) || !automaticFollowUpAllowed(chatId)) {
				parked = true;
				return;
			}

			s.queues.delete(chatId);
			const steers = fire.map((e) => e.steer);

			const status = await s.turnRunner(chatId, { type: "steers", steers }).catch((err: unknown) => {
				console.error(`[steer ${steers.map((x) => x.id).join(",")}] wake turn crashed:`, err);
				return -1;
			});
			if (status === 403) {
				const back = s.queues.get(chatId) ?? [];
				back.push(...fire);
				s.queues.set(chatId, back);
				parked = true;
				return;
			}
			if (status === 409) {
				const back = s.queues.get(chatId) ?? [];
				back.push(...fire);
				s.queues.set(chatId, back);
				await delay(RETRY_BACKOFF_MS[Math.min(attempt++, RETRY_BACKOFF_MS.length - 1)]!);
				continue;
			}
			attempt = 0;

			if (status === 200) {
				for (const entry of fire) {
					finalizeSteer(entry.steer);
					entry.resolve();
				}
			} else {
				const err = new Error(`wake turn failed with status ${status}`);
				for (const entry of fire) {
					failSteer(entry.steer, err);
					entry.reject(err);
				}
			}
		}
	} finally {
		s.pumping.delete(chatId);
		const q = state().queues.get(chatId) ?? [];
		if (!parked && automaticFollowUpAllowed(chatId, state().liveAgents.get(chatId)) && q.some((e) => e.handedTo === undefined)) void pump(chatId);
	}
}

state().stopConnectionWatch?.();
state().stopConnectionWatch = onSubscriptionChange(() => {
	const s = state();
	for (const [chatId, agent] of s.liveAgents) {
		if (!isSubscriptionProvider(agent.state?.model?.provider) || automaticFollowUpAllowed(chatId, agent)) continue;
		const consumed = new Set(agent.state.messages.map((m) => (m as { id?: string }).id));
		const pending = (s.queues.get(chatId) ?? []).filter((entry) => entry.handedTo === agent && !consumed.has(entry.steer.id));
		if (pending.length === 0) continue;
		agent.clearSteeringQueue();
		for (const entry of pending) entry.handedTo = undefined;
		for (const entry of s.userSteers.get(chatId) ?? []) if (!consumed.has(entry.message.id)) entry.handedTo = undefined;
		handOffEligible(chatId, agent); // only unconsumed learner input; never replay consumed steers
	}
	for (const chatId of s.queues.keys()) {
		if (automaticFollowUpAllowed(chatId, s.liveAgents.get(chatId))) void pump(chatId);
	}
});

function finalizeJob(jobId: string): void {
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	const result = job.result;
	const failed = result ? isSubagentFailure(job.kind, result as never) : true;
	stores.jobStore.updateJob(jobId, {
		status: failed ? "error" : "done",
		activity: failed ? "failed" : "delivered",
	});
}

function failJob(jobId: string, err: Error): void {
	const job = stores.jobStore.getJob(jobId);
	if (!job || job.status !== "running") return;
	stores.jobStore.updateJob(jobId, { status: "error", error: err.message, activity: "delivery failed" });
}

async function waitForIdle(chatId: string): Promise<void> {
	for (;;) {
		const record = stores.chatStore.getChat(chatId);
		if (!record) return;
		const blocked = isTurnRunning(chatId) || danglingQuestionOf(record.messages) !== null;
		if (!blocked) {
			await delay(GRACE_MS);
			const recheck = stores.chatStore.getChat(chatId);
			if (
				!isTurnRunning(chatId) &&
				recheck &&
				danglingQuestionOf(recheck.messages) === null
			) {
				return;
			}
		}
		await delay(POLL_MS);
	}
}

const SWEEP_THROTTLE_MS = 30_000;

export function recoverStaleJobs(): void {
	const s = state();
	const now = Date.now();
	if (now - s.lastSweepAt < SWEEP_THROTTLE_MS) return;
	s.lastSweepAt = now;
	try {
		for (const chat of stores.chatStore.listChats()) {
			for (const job of stores.jobStore.listJobs(chat.id)) {
				if (job.status !== "running") continue;
				if (isJobLive(job.id)) continue;
				if (!stores.chatStore.getChat(job.chatId)) continue;
				if (isTurnRunning(job.chatId)) continue;
				if (job.result) {
					const steer = buildSubagentSteer(job, job.result as never);
					stores.jobStore.updateJob(job.id, { activity: "recovering: re-delivering" });
					void deliverJobResult(steer).catch(() => {
						/* deliverJobResult marks the job error on failure */
					});
				} else {
					if (!s.respawn) continue;
					stores.jobStore.updateJob(job.id, { activity: "recovering: re-running" });
					s.respawn(job.id);
				}
			}
		}
	} catch (err) {
		console.error("[jobs] stale-job recovery sweep failed:", err);
	}
}

export function listJobs(chatId: string): JobRecord[] {
	if (process.env.NODE_ENV !== "test") recoverStaleJobs();
	return stores.jobStore.listJobs(chatId);
}
