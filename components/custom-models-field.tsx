"use client";

/**
 * THE MODELS FIELD of an OpenAI-compatible provider (per-model
 * capabilities, owner 2026-10-28): one row per model with Vision and
 * Thinking switches (a wire-format select while thinking), the context
 * window and the max output — the way built-in connectors describe their
 * models. Shared by the connect form (setup) and the edit view in
 * Settings → Keys.
 *
 * "Find models" asks the server's /models; a model it lists joins with
 * whatever capabilities the server described (OpenRouter-style fields,
 * Ollama, LM Studio). Nothing is assumed beyond that — an undescribed
 * model starts text-only, no thinking, 128k, 8192, and the user sets it.
 */

import { useState } from "react";
import {
	CUSTOM_CONTEXT_MAX,
	CUSTOM_CONTEXT_MIN,
	CUSTOM_PROVIDER_MODELS_MAX,
	CUSTOM_THINKING_FORMATS,
	defaultCustomModel,
	type CustomModelDetected,
	type CustomModelEntry,
	type CustomThinkingFormat,
} from "@/src/core";
import { ThinSelect, Toggle } from "@/components/settings/controls";
import { Icon } from "@/components/ui/icon";

/** The thinking formats in the learner's words. */
export const THINKING_FORMAT_LABELS: Record<CustomThinkingFormat, string> = {
	openai: "OpenAI (reasoning_effort)",
	openrouter: "OpenRouter (reasoning)",
	deepseek: "DeepSeek (thinking)",
	qwen: "Qwen (enable_thinking)",
	"qwen-chat-template": "Qwen chat template",
	zai: "Z.AI (thinking)",
	together: "Together (reasoning)",
	"string-thinking": "String thinking field",
};

/** Pure: a model-id list from free text (commas, spaces or newlines). */
export function parseModelIds(text: string): string[] {
	return [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];
}

/** Pure: a new model row with what the server described applied over the
 *  defaults (max output never above the context window). */
export function modelWithDetected(id: string, detected: CustomModelDetected | undefined): CustomModelEntry {
	const m = { ...defaultCustomModel(id), ...detected };
	return { ...m, maxTokens: Math.min(m.maxTokens, m.contextWindow), ...(m.thinking ? { thinkingFormat: "openai" as const } : {}) };
}

export function CustomModelsField({
	baseUrl,
	apiKey,
	providerId,
	models,
	onChange,
	autoFill,
}: {
	baseUrl: string;
	/** The key typed in the form (blank = none, or the stored one below). */
	apiKey: string;
	/** A saved provider: the probe sends its stored key when none is typed. */
	providerId?: string;
	models: CustomModelEntry[];
	onChange: (next: CustomModelEntry[]) => void;
	/** Add the first few listed models when the list is empty (the connect form). */
	autoFill?: boolean;
}) {
	const [draft, setDraft] = useState("");
	const [found, setFound] = useState<string[] | null>(null);
	const [detected, setDetected] = useState<Record<string, CustomModelDetected>>({});
	const [probing, setProbing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const has = (id: string) => models.some((m) => m.id === id);
	const add = (ids: string[], caps = detected) => {
		const fresh = ids.filter((id) => !has(id)).map((id) => modelWithDetected(id, caps[id]));
		if (fresh.length) onChange([...models, ...fresh].slice(0, CUSTOM_PROVIDER_MODELS_MAX));
	};
	const remove = (id: string) => onChange(models.filter((m) => m.id !== id));
	const patch = (id: string, next: Partial<CustomModelEntry>) =>
		onChange(models.map((m) => (m.id === id ? { ...m, ...next } : m)));

	const probe = async () => {
		if (!baseUrl.trim() || probing) return;
		setProbing(true);
		setError(null);
		const res = await fetch("/api/providers/custom/probe", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ baseUrl: baseUrl.trim(), ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}), ...(providerId ? { providerId } : {}) }),
		}).catch(() => null);
		setProbing(false);
		const body = (await res?.json().catch(() => null)) as
			| { ok?: boolean; models?: string[]; detected?: Record<string, CustomModelDetected>; error?: string }
			| null;
		if (!body?.ok) {
			setFound(null);
			setError(body?.error ?? "Couldn’t reach that endpoint.");
			return;
		}
		const caps = body.detected ?? {};
		setFound(body.models ?? []);
		setDetected(caps);
		if (autoFill && models.length === 0 && body.models?.length) add(body.models.slice(0, 3), caps);
	};

	const commitDraft = () => {
		const ids = parseModelIds(draft);
		if (ids.length) add(ids);
		setDraft("");
	};

	return (
		<div className="su-field" data-testid="custom-models-field">
			<span className="flabel">
				<label htmlFor="custom-model-add">Models</label>
				<button type="button" className="ghost sm" disabled={!baseUrl.trim() || probing} onClick={() => void probe()} data-testid="custom-models-find">
					<Icon name={probing ? "loading" : "search"} size="sm" />
					{probing ? "Looking…" : "Find models"}
				</button>
			</span>
			<input
				id="custom-model-add"
				className="finput mono"
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === "Enter" || e.key === ",") {
						e.preventDefault();
						commitDraft();
					}
				}}
				onBlur={commitDraft}
				placeholder="Type a model id and press Enter"
				spellCheck={false}
				data-testid="custom-model-add"
			/>
			{found && found.length > 0 && (
				<span className="su-chips">
					{found.slice(0, 24).map((id) => {
						const on = has(id);
						return (
							<button key={id} type="button" className={on ? "chip on" : "chip"} aria-pressed={on} onClick={() => (on ? remove(id) : add([id]))}>
								{on && <Icon name="check" size="xs" />}
								{id}
							</button>
						);
					})}
				</span>
			)}
			{found && found.length === 0 && <span className="fhint">The server answered but listed no models. Type their ids above.</span>}
			{error && (
				<span role="alert" className="ferror">
					{error}
				</span>
			)}
			{models.length > 0 ? (
				<div className="cm-list" data-testid="custom-model-rows">
					{models.map((m) => (
						<CustomModelRow key={m.id} model={m} fromServer={detected[m.id] !== undefined} onPatch={(next) => patch(m.id, next)} onRemove={() => remove(m.id)} />
					))}
				</div>
			) : (
				!found && <span className="fhint">Add the ids your server serves, or let “Find models” ask it.</span>
			)}
			{models.length > 0 && (
				<span className="fhint">
					Turn on Vision only for models that read images, and Thinking only for models that reason. A model with Vision on can fill the vision slot.
				</span>
			)}
		</div>
	);
}

/** One model's capabilities. The number fields commit on blur (an invalid
 *  value snaps back to the saved one). */
function CustomModelRow({
	model,
	fromServer,
	onPatch,
	onRemove,
}: {
	model: CustomModelEntry;
	/** The server described this model (the probe's detection applied). */
	fromServer: boolean;
	onPatch: (next: Partial<CustomModelEntry>) => void;
	onRemove: () => void;
}) {
	const slug = model.id.toLowerCase().replace(/[^a-z0-9]+/g, "-");
	return (
		<div className="cm-row" data-testid={`custom-model-${slug}`}>
			<div className="cm-head">
				<span className="cm-id" title={model.id}>
					{model.id}
				</span>
				{fromServer && <span className="pill muted">Read from server</span>}
				<button type="button" className="cm-x" aria-label={`Remove ${model.id}`} onClick={onRemove} data-testid={`custom-model-${slug}-remove`}>
					<Icon name="close" size="sm" />
				</button>
			</div>
			<div className="cm-caps">
				<span className="cm-cap">
					<Toggle label={`${model.id} vision`} checked={model.vision} onChange={(vision) => onPatch({ vision })} />
					Vision
				</span>
				<span className="cm-cap">
					<Toggle
						label={`${model.id} thinking`}
						checked={model.thinking}
						onChange={(thinking) => onPatch(thinking ? { thinking, thinkingFormat: model.thinkingFormat ?? "openai" } : { thinking, thinkingFormat: undefined })}
					/>
					Thinking
				</span>
				{model.thinking && (
					<ThinSelect
						value={model.thinkingFormat ?? "openai"}
						onChange={(v) => onPatch({ thinkingFormat: v as CustomThinkingFormat })}
						ariaLabel={`${model.id} thinking format`}
						testid={`custom-model-${slug}-format`}
					>
						{CUSTOM_THINKING_FORMATS.map((f) => (
							<option key={f} value={f}>
								{THINKING_FORMAT_LABELS[f]}
							</option>
						))}
					</ThinSelect>
				)}
				<span className="cm-limits">
				<TokenInput
					label="Context"
					ariaLabel={`${model.id} context window`}
					value={model.contextWindow}
					min={CUSTOM_CONTEXT_MIN}
					max={CUSTOM_CONTEXT_MAX}
					onCommit={(contextWindow) => onPatch({ contextWindow, maxTokens: Math.min(model.maxTokens, contextWindow) })}
				/>
				<TokenInput
					label="Max output"
					ariaLabel={`${model.id} max output`}
					value={model.maxTokens}
					min={1}
					max={model.contextWindow}
					onCommit={(maxTokens) => onPatch({ maxTokens })}
				/>
				</span>
			</div>
		</div>
	);
}

function TokenInput({
	label,
	ariaLabel,
	value,
	min,
	max,
	onCommit,
}: {
	label: string;
	ariaLabel: string;
	value: number;
	min: number;
	max: number;
	onCommit: (next: number) => void;
}) {
	const [draft, setDraft] = useState<string | null>(null);
	const commit = () => {
		if (draft === null) return;
		const n = Number(draft.replace(/[,_\s]/g, ""));
		if (Number.isInteger(n) && n >= min && n <= max) onCommit(n);
		setDraft(null);
	};
	return (
		<label className="cm-num">
			<span>{label}</span>
			<input
				className="finput sm st-num"
				inputMode="numeric"
				value={draft ?? String(value)}
				aria-label={ariaLabel}
				onChange={(e) => setDraft(e.target.value)}
				onBlur={commit}
				onKeyDown={(e) => {
					if (e.key === "Enter") {
						e.preventDefault();
						commit();
					}
				}}
			/>
		</label>
	);
}
