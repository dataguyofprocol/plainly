import type { Usage } from "@earendil-works/pi-ai";
import {
	createPracticeAgent,
	createProberAgent,
	createTeacherAgent,
	type AgentBuildOptions,
	type TeachingAgent,
} from "../agent/teacher-agent.ts";
import { piEngineForSpec, type PiEngine } from "../agent/models.ts";
import { connectionBackgroundAllowed, connectionScopeCurrent, isSubscriptionProvider } from "../agent/subscription-connections.ts";
import { nativeSubscriptionError } from "../agent/subscription-stream.ts";
import { chatGPTStreamError } from "../agent/chatgpt-stream.ts";
import { SubscriptionRequestCycle, type SubscriptionDispatchLifecycle } from "../agent/subscription-request-cycle.ts";
import { reconstructRequestCause } from "../core/native-messages.ts";
import { createJobRunner } from "../agent/subagents/runner.ts";
import { createExtractionPipeline } from "../agent/subagents/extraction.ts";
import type { ModelRole } from "../../config.ts";
import {
	deliverJobResult,
	noteSteerVisible,
	reconcileUserSteers,
	registerLiveAgent,
	restoreUncommittedAutomatic,
	setJobRespawn,
	setTurnRunner,
	settleSteers,
	steerLiveChat,
	unregisterLiveAgent,
} from "./jobs.ts";
import { runPiTurn } from "./pi/ui-stream.ts";
import { collectToolCallIds } from "./pi/call-ids.ts";
import { providerEventNote } from "../agent/provider-events.ts";
import { effectiveSettings, stores } from "./stores.ts";
import { searchAvailable, searchProvider } from "./search.ts";
import { providerKeyPresent } from "./keys.ts";
import {
	extractionEnabled,
	graphToolsEnabled,
	resolveConversationSpec,
	resolveRoleSpec,
} from "../core/settings-resolution.ts";
import { modelsNotConfigured, providerKeyMissing as providerKeyMissingEnvelope, type ProviderKeyMissing } from "../core/settings.ts";
import { beginTurn, endTurn } from "./turn-liveness.ts";
import { applyParkedDismissal } from "./dismissal-park.ts";
import { registerTurn, unregisterTurn } from "./turn-runs.ts";
import { persistTurn, triggerExtraction } from "./turn-service.ts";
import { hasProbeDone, danglingQuestionOf } from "../core/native-messages.ts";
import { composeInstructions } from "../agent/teacher-agent.ts";
import { ensureCompacted, kickCompaction, effectiveThresholdTokens } from "./compaction.ts";
import { catalogContextLimits, refreshConnectionCatalog } from "./model-catalog.ts";
import { emit } from "../core/events.ts";
import { settledTurnResponse } from "./turn-runs.ts";
import { asAgentMessages } from "../core/native-messages.ts";
import {
	ChatInputError,
	inputAppends,
	parseChatInput,
	type TurnInput,
} from "../core/input-events.ts";
import { steerDelivered } from "../core/contracts.ts";
import type {CallUsage, SteerMessage} from "../core/contracts.ts";

const jobRunner = createJobRunner({
	chatStore: stores.chatStore,
	jobStore: stores.jobStore,
	deliver: deliverJobResult,
	engineFor: (role) =>
		resolveEngine(role),
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
	searchProvider,
});
export const extraction = createExtractionPipeline({
	...stores,
	engineFor: (role) =>
		resolveEngine(role),
	providerKeyMissing: (provider, tier) =>
		providerKeyPresent(provider) ? null : providerKeyMissingEnvelope(provider, [tier]),
});

setTurnRunner(async (chatId, input) => {
	const res = await handleChatInput(chatId, input);
	await res.arrayBuffer().catch(() => undefined);
	return res.status;
});
function resolveEngine(role: ModelRole): PiEngine | undefined {
	const spec = resolveRoleSpec(role, stores.settingsStore.readSettings());
	return spec ? piEngineForSpec(spec) : undefined;
}

setJobRespawn((jobId) => void jobRunner.runJob(jobId));

export async function handleChatRequest(
	req: Request,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
): Promise<Response> {
	let body: { chatId?: unknown; input?: unknown };
	try {
		body = await req.json();
	} catch {
		return Response.json({ error: "Invalid JSON body" }, { status: 400 });
	}
	const chatId = typeof body.chatId === "string" ? body.chatId : "";
	if (!chatId) return Response.json({ error: "Unknown chat" }, { status: 404 });
	let input: TurnInput;
	try {
		input = parseChatInput(body.input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}
	return handleChatInput(chatId, input, buildAgent);
}

export async function handleChatInput(
	chatId: string,
	input: TurnInput,
	buildAgent?: (opts: AgentBuildOptions & { teaching: boolean }) => TeachingAgent,
): Promise<Response> {
	let record = stores.chatStore.getChat(chatId);
	if (!record) {
		return Response.json({ error: "Unknown chat" }, { status: 404 });
	}

	const effective = effectiveSettings();
	const conversation = resolveConversationSpec(record.settings, effective.models.strong);
	if (!conversation) {
		const envelope = modelsNotConfigured(["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	if (isSubscriptionProvider(conversation.provider)) {
		await refreshConnectionCatalog(conversation.provider);
		if (input.type === "steers" && !connectionBackgroundAllowed(conversation.provider)) {
			return Response.json({ error: "Background use is off for this connection. Automatic follow-up remains deferred in its queue." }, { status: 403 });
		}
	}
	if (!providerKeyPresent(conversation.provider)) {
		const envelope = providerKeyMissingEnvelope(conversation.provider, ["strong"]);
		console.info(`[chat ${chatId}] turn refused — ${JSON.stringify(envelope)}`);
		return Response.json(envelope, { status: 503 });
	}

	const callPurpose = { background: input.type === "steers" || (input.type === "continue" && reconstructRequestCause(record.messages) !== "foreground") };
	let requestCycle: SubscriptionRequestCycle | undefined;
	const lifecycle: SubscriptionDispatchLifecycle = {
		captured: (scope) => requestCycle?.captured(scope),
		beforeDispatch: (scope) => requestCycle?.beforeDispatch(scope),
		noDispatch: (kind) => requestCycle?.noDispatch(kind),
	};
	let conversationEngine: PiEngine;
	try { conversationEngine = piEngineForSpec(conversation, () => callPurpose.background, lifecycle); }
	catch { return Response.json({ error: conversation.provider === "chatgpt" ? chatGPTStreamError("model catalog") : isSubscriptionProvider(conversation.provider) ? nativeSubscriptionError(conversation.provider, "model catalog") : "The selected model is unavailable." }, { status: 503 }); }
	const modelIdForCompaction = `${conversationEngine.model.provider}:${conversationEngine.model.id}`;
	await ensureCompacted(
		{
			chatStore: stores.chatStore,
			engine: piEngineForSpec(conversation, true),
			canStart: () => connectionBackgroundAllowed(conversation.provider),
			modelId: modelIdForCompaction,
			kind: record.kind === "practice" ? "practice" : hasProbeDone(record.messages) ? "teach" : "probe",
			thresholdTokens: effectiveThresholdTokens(
				effective.compaction?.thresholdTokens,
				catalogContextLimits().get(modelIdForCompaction),
			),
			systemPromptTokens: Math.ceil(composeInstructions(record.kind === "practice" ? "practice" : "teacher").length / 4),
		},
		chatId,
	);
	const compactedRecord = stores.chatStore.getChat(chatId);
	if (compactedRecord) record = compactedRecord;

	let appends;
	try {
		appends =
			input.type === "steers"
				? input.steers.filter((s) => !steerDelivered(record.messages, s.id))
				: inputAppends(record, input);
	} catch (err) {
		if (err instanceof ChatInputError) {
			return Response.json({ error: err.message }, { status: 400 });
		}
		throw err;
	}

	// Providers reject a tool result appended after an intervening assistant
	// message, so an answer that leaves a sibling question dangling defers its
	// wake: the last answer fires one turn with every result adjacent.
	if (input.type === "answer" && danglingQuestionOf([...record.messages, ...appends]) !== null) {
		const merged = [...record.messages, ...appends];
		stores.chatStore.saveMessages(chatId, merged);
		emit("record-changed", { chatId });
		return settledTurnResponse(); // the cheap terminal — no beginTurn, no turn
	}

	if (!beginTurn(chatId)) {
		console.info(`[chat ${chatId}] turn already in flight — request rejected`);
		return Response.json({ error: "A turn is already running for this session" }, { status: 409 });
	}

	const merged = [...record.messages, ...appends];
	const stagedAutomatic = isSubscriptionProvider(conversation.provider) && input.type === "steers";
	let persistBaseCount = stagedAutomatic ? record.messages.length : merged.length;
	try {
		if (!stagedAutomatic) stores.chatStore.saveMessages(chatId, merged);
		for (const appended of stagedAutomatic ? [] : appends) {
			if ((appended as { role?: string }).role === "custom") noteSteerVisible(appended as SteerMessage);
		}
	} catch (err) {
		console.error(`[chat ${chatId}] write-ahead persist failed:`, err);
	}

	const turnUsageId = crypto.randomUUID();
	const steps: CallUsage[] = [];
	const collectUsage = (usage: Usage) => {
		steps.push({
			inputTokens: usage.input,
			outputTokens: usage.output,
			cacheReadTokens: usage.cacheRead,
			cacheWriteTokens: usage.cacheWrite,
			cacheWrite1hTokens: usage.cacheWrite1h ?? 0,
			// Optional in pi's Usage — persisted as 0, never dropped.
			reasoningTokens: usage.reasoning ?? 0,
		});
	};

	// See docs/probe-teach-split.md §2.
	const teaching = hasProbeDone(merged);
	const engine = conversationEngine;
	const modelId = `${engine.model.provider}:${engine.model.id}`;
	if (isSubscriptionProvider(conversation.provider)) requestCycle = new SubscriptionRequestCycle({
		initialMessages: asAgentMessages(merged),
		staged: stagedAutomatic ? asAgentMessages(appends) : undefined,
		foregroundOwed: !callPurpose.background,
		purpose: callPurpose,
		scopeCurrent: (scope) => connectionScopeCurrent(conversation.provider, scope),
		commitStaged: () => { stores.chatStore.saveMessages(chatId, merged); persistBaseCount = merged.length; },
		restoreAutomatic: (automaticIds, retainedIds) => restoreUncommittedAutomatic(chatId, constructed, automaticIds, retainedIds),
	});
	const agentOpts: AgentBuildOptions = {
		engine,
		callPurpose,
		requestCycle,
		messages: asAgentMessages(merged),
		onUsage: collectUsage,
		toolToggles: effective.agent.tools,
		chatId,
		promptSwitches: effective.agent.prompts,
	};
	const constructed: TeachingAgent = buildAgent
		? buildAgent({ ...agentOpts, teaching })
		: record.kind === "practice"
			? createPracticeAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						graphNodes: () => stores.graphStore.readNodes(),
						jobs: {
							chatId,
							jobStore: stores.jobStore,
							spawn: (job, input) => void jobRunner.runJob(job.id, input),
							searchAvailable,
						},
						...(graphToolsEnabled(effective) ? { graph: { chatStore: stores.chatStore, graphStore: stores.graphStore } } : {}),
					},
					agentOpts,
				)
			: teaching
			? createTeacherAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						searchAvailable,
					},
					agentOpts,
				)
			: createProberAgent(
					{
						chatId,
						chatStore: stores.chatStore,
						deliver: (steer) => void deliverJobResult(steer),
						jobStore: stores.jobStore,
						spawn: (job, input) => void jobRunner.runJob(job.id, input),
						searchAvailable,
						...(graphToolsEnabled(effective) ? { graphStore: stores.graphStore } : {}),
					},
					agentOpts,
				);

	try {
		// Register the live agent BEFORE runPiTurn: pi's continue() drains the
		// steering queue synchronously inside that call.
		registerLiveAgent(chatId, constructed);
		providerEventNote(chatId, "turn", `run start (base: ${merged.length} messages)`);
		const handle = runPiTurn({
			agent: constructed,
			requestCycle,
			...(process.env.LH_UPDATE_FLUSH_MS ? { updateFlushMs: Number(process.env.LH_UPDATE_FLUSH_MS) } : {}),
			// THE LACAN FIX (2026-10-04): seed the uniquifier with every
			// tool-call id the record already holds — a provider that resets
			// ids per response (DeepSeek) then gets fresh unique ids for this
			// turn's calls at the wire boundary, on the wire, in the record,
			// and in the next turn's context alike.
			usedToolCallIds: new Set(collectToolCallIds(merged)),
			onError: (error) => {
				if (conversation.provider === "chatgpt") return chatGPTStreamError(String(error));
				if (isSubscriptionProvider(conversation.provider)) return nativeSubscriptionError(conversation.provider, String(error));
				console.error(`[chat ${chatId}] turn error:`, error);
				return "An error occurred.";
			},
			onFinish: (turnMessages, isAborted) => {
				const stamped = persistTurn(stores.chatStore, chatId, persistBaseCount, turnMessages, isAborted);
				const response = stamped.find((m) => (m as { role?: string }).role === "assistant");
				if (response && steps.length > 0) {
					stores.chatStore.appendTurnUsage(chatId, {
						id: turnUsageId,
						messageId: response.id,
						at: new Date().toISOString(),
						model: modelId,
						steps,
					});
				}
				if ((!requestCycle || requestCycle.dispatched) && record.kind !== "practice" && extractionEnabled(effective.graph)) {
					triggerExtraction(stores, extraction, chatId, effective.graph.extractionChunkTokens);
				}
				applyParkedDismissal(stores.chatStore, chatId);
				endTurn(chatId);
				unregisterTurn(chatId);
				unregisterLiveAgent(chatId);
				settleSteers(chatId, stamped);
				reconcileUserSteers(chatId, stamped);
				if (process.env.NODE_ENV !== "test" && (!requestCycle || requestCycle.dispatched))
					kickCompaction(() => {
						const fresh = effectiveSettings();
						const spec = resolveConversationSpec(stores.chatStore.getChat(chatId)?.settings, fresh.models.strong);
						if (!spec || !connectionBackgroundAllowed(spec.provider)) return null;
						let kickEngine: PiEngine;
						try { kickEngine = piEngineForSpec(spec, true); } catch { return null; }
						const kickModelId = `${kickEngine.model.provider}:${kickEngine.model.id}`;
						const freshRecord = stores.chatStore.getChat(chatId);
						if (!freshRecord) return null;
						return {
							chatStore: stores.chatStore,
							engine: kickEngine,
							canStart: () => connectionBackgroundAllowed(spec.provider),
							modelId: kickModelId,
							kind: freshRecord.kind === "practice" ? "practice" : hasProbeDone(freshRecord.messages) ? "teach" : "probe",
							thresholdTokens: effectiveThresholdTokens(
								fresh.compaction?.thresholdTokens,
								catalogContextLimits().get(kickModelId),
							),
							systemPromptTokens: Math.ceil(composeInstructions(freshRecord.kind === "practice" ? "practice" : "teacher").length / 4),
						};
					}, chatId);
			},
		});
		registerTurn(chatId, handle);
		// The browser's 6-connections-per-origin pool is the scarce resource, so
		// the POST acknowledges and closes; the submitter attaches through
		// GET /api/chats/[id]/stream.
		if (stagedAutomatic && requestCycle && !(await requestCycle.admission)) return Response.json({ error: "Automatic follow-up remains deferred in its queue." }, { status: 403 });
		return Response.json({ ok: true });
	} catch (err) {
		endTurn(chatId);
		unregisterLiveAgent(chatId);
		console.error(`[chat ${chatId}] turn failed to start:`, err);
		return Response.json({ error: "Failed to start the turn" }, { status: 500 });
	}
}
