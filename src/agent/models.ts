import {
	clampThinkingLevel,
	createModels,
	createProvider,
	getSupportedThinkingLevels,
	type Api,
	type Model,
	type Models,
	type StreamFunction,
} from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type ModelRole } from "../../config.ts";
import { DEFAULT_THINKING_ORDER } from "../core/settings.ts";
import { customProviderEnvVar, type CustomProviderEntry } from "../core/custom-providers.ts";
import packageMetadata from "../../package.json" with { type: "json" };
import { chatGPTModel } from "./chatgpt-bridge.ts";
import { chatGPTStream } from "./chatgpt-stream.ts";
import type { ChatGPTDispatchLifecycle } from "./chatgpt-request-cycle.ts";
import { nativeSubscriptionId, nativeSubscriptionModel } from "./subscription-bridge.ts";
import { nativeSubscriptionStream } from "./subscription-stream.ts";

/** App identity is immutable and shared by Models and every native Agent.
 * Agent's default Pi attribution otherwise overrides the Models identity. */
export const APP_IDENTITY = Object.freeze({
	userAgent: Object.freeze({ custom: `plainly/${packageMetadata.version}` }),
	attribution: Object.freeze({ name: packageMetadata.name, url: packageMetadata.homepage }),
});

/** See docs/pi-engine-swap.md. */

export interface PiEngine {
	model: Model<Api>;
	streamFn: StreamFunction;
	level?: ThinkingLevel;
}

export type { ThinkingLevel };

let collection: ReturnType<typeof createModels> | undefined;

export function piModels() {
	if (!collection) {
		collection = createModels({ identity: APP_IDENTITY });
		for (const provider of builtinProviders()) collection.setProvider(provider);
		syncCustomProviders();
	}
	return collection;
}

let customSource: () => readonly CustomProviderEntry[] = () => [];
let customIds = new Set<string>();

/** The key a keyless endpoint is sent: openai-completions refuses to
 *  dispatch without one, and servers started without auth ignore it. */
export const CUSTOM_PROVIDER_NO_KEY = "no-key";

export function setCustomProviderSource(source: () => readonly CustomProviderEntry[]): void {
	customSource = source;
	if (collection) syncCustomProviders();
}

export function syncCustomProviders(): void {
	const models = collection;
	if (!models) return;
	const entries = customSource();
	const next = new Set(entries.map((e) => e.id));
	for (const id of customIds) if (!next.has(id)) models.deleteProvider(id);
	for (const entry of entries) models.setProvider(customProvider(entry));
	customIds = next;
}

/** The compat pins avoid the OpenAI-only request features (store, the
 *  developer role, max_completion_tokens) that self-hosted servers
 *  commonly reject. */
export function customProvider(entry: CustomProviderEntry) {
	const envVar = customProviderEnvVar(entry.id);
	const models: Model<"openai-completions">[] = entry.models.map((m) => ({
		id: m.id,
		name: m.id,
		api: "openai-completions",
		provider: entry.id,
		baseUrl: entry.baseUrl,
		reasoning: m.thinking,
		input: m.vision ? ["text", "image"] : ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: m.contextWindow,
		maxTokens: m.maxTokens,
		compat: {
			supportsStore: false,
			supportsDeveloperRole: false,
			maxTokensField: "max_tokens",
			...(m.thinking ? { thinkingFormat: m.thinkingFormat ?? "openai" } : {}),
		},
	}));
	return createProvider({
		id: entry.id,
		name: entry.name,
		baseUrl: entry.baseUrl,
		auth: {
			apiKey: {
				name: `${entry.name} API key`,
				resolve: async ({ ctx, signal }) => {
					signal.throwIfAborted();
					const key = await ctx.env(envVar);
					return key ? { auth: { apiKey: key }, source: envVar } : { auth: { apiKey: CUSTOM_PROVIDER_NO_KEY }, source: "keyless" };
				},
			},
		},
		models,
		api: openAICompletionsApi(),
	});
}

export function openRouterApiKey(): string | undefined {
	return process.env.OPENROUTER_API_KEY || undefined;
}

export interface ResolvedModelSpec {
	provider: string;
	id: string;
	thinkingLevel?: ThinkingLevel;
}

function defaultThinkingLevel(model: Model<Api>): ThinkingLevel {
	const supported = getSupportedThinkingLevels(model);
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

export function piEngineForSpec(spec: ResolvedModelSpec, background: boolean | (() => boolean) = true, lifecycle?: ChatGPTDispatchLifecycle): PiEngine {
	const models: Models = piModels();
	const nativeId = nativeSubscriptionId(spec.provider);
	const model = spec.provider === "chatgpt" ? chatGPTModel(spec.id) : nativeId ? nativeSubscriptionModel(spec.provider, spec.id) : models.getModel(spec.provider, spec.id);
	if (!model) {
		throw new Error(`${spec.provider} catalog has no model ${spec.id}`);
	}
	const level = spec.thinkingLevel
		? clampThinkingLevel(model, spec.thinkingLevel)
		: defaultThinkingLevel(model);
	return {
		model,
		level,
		streamFn: (requestModel, context, options) => {
			const purpose = typeof background === "function" ? background : () => background;
			const stream = spec.provider === "chatgpt" ? chatGPTStream(purpose, lifecycle) : nativeId ? nativeSubscriptionStream(models.getProvider(nativeId)!, purpose, lifecycle) : models.streamSimple.bind(models);
			return stream(requestModel, context, { ...options, reasoning: level === "off" ? undefined : level });
		},
	};
}

export function piEngineFor(role: ModelRole): PiEngine {
	throw new Error(
		`no configured model for role "${role}" — set your model slots (settings → models)`,
	);
}
