"use client";

import { useEffect, useRef, useState } from "react";
import type { ModelCatalogEntry } from "@/src/core";
import { fuzzyScore, subscriptionLabel } from "@/src/core";
import { formatTokens } from "@/components/usage-format";
import { Icon } from "@/components/ui/icon";

const PROVIDER_NAMES: Record<string, string> = {
	openai: "OpenAI",
	openrouter: "OpenRouter",
	anthropic: "Anthropic",
	deepseek: "DeepSeek",
	google: "Google",
	zai: "Z.AI",
	xai: "xAI",
	groq: "Groq",
	mistral: "Mistral",
	chatgpt: "ChatGPT",
};
export function providerName(id: string): string {
	return PROVIDER_NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1);
}

function MenuSearch(props: React.ComponentProps<"input">) {
	return (
		<div className="mm-search">
			<Icon name="search" size="sm" />
			<input {...props} className="finput sm" spellCheck={false} autoComplete="off" />
		</div>
	);
}

function priceLabel(cost: ModelCatalogEntry["cost"]): string {
	const fmt = (n: number) => `$${n < 1 ? n.toFixed(2).replace(/0$/, "") : n.toFixed(2)}`;
	return `${fmt(cost.input)}/${fmt(cost.output)}`;
}

export function ModelMenuList({
	models,
	effectiveId,
	effectiveProvider,
	onPick,
	footer,
}: {
	models: ModelCatalogEntry[] | undefined;
	effectiveId: string | undefined;
	effectiveProvider?: string;
	onPick: (entry: ModelCatalogEntry) => void;
	footer?: string;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);

	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const results = (models ?? [])
		.map((m) => ({ m, s: fuzzyScore(query, m.provider, m.id, m.name) }))
		.filter((r) => r.s !== null)
		.sort((a, b) => b.s! - a.s! || a.m.id.localeCompare(b.m.id))
		.map((r) => r.m);
	const order = [...new Set(results.map((m) => m.provider))];
	results.sort((a, b) => order.indexOf(a.provider) - order.indexOf(b.provider));

	return (
		<>
			<MenuSearch
				ref={searchRef}
				data-testid="model-search"
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setMenuIdx(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						e.stopPropagation();
						if (results.length === 0) return;
						setMenuIdx((i) =>
							e.key === "ArrowDown"
								? Math.min((i ?? -1) + 1, results.length - 1)
								: Math.max((i ?? results.length) - 1, 0),
						);
					} else if (e.key === "Enter") {
						const chosen = results[menuIdx ?? 0];
						if (chosen) {
							e.preventDefault();
							e.stopPropagation();
							onPick(chosen);
						}
					}
				}}
				placeholder="Search models…"
			/>
			{!models && (
				<div className="mm-note" aria-busy="true">
					Loading models…
				</div>
			)}
			{models && results.length === 0 && <div className="mm-note">No models match.</div>}
			<ul ref={listRef} data-testid="model-list" className="mm-list">
				{results.map((m, i) => {
					const sub = subscriptionLabel(`${m.provider}:${m.id}`);
					const on = m.id === effectiveId && m.provider === (effectiveProvider ?? m.provider);
					const head = i === 0 || results[i - 1]!.provider !== m.provider;
					return (
						<li key={`${m.provider}/${m.id}`}>
							{head && <div className="over mm-group">{sub ? `${sub} (subscription)` : providerName(m.provider)}</div>}
							<button
								type="button"
								data-testid={`model-option-${m.id.replace(/[^a-z0-9-]/gi, "_")}`}
								data-idx={i}
								onClick={() => onPick(m)}
								className={`mm-row two${i === menuIdx ? " walk" : ""}${on ? " on" : ""}`}
							>
								<span className="mm-line">
									<span className="mm-name">
										<span>{m.name}</span>
										{on && <Icon name="check" size="sm" className="tick" />}
									</span>
									<span className="mm-meta" title={sub ? "Included in your subscription" : "USD per 1M tokens, in / out"}>
										{sub ?? (m.unpriced ? "Price unknown" : priceLabel(m.cost))}
									</span>
								</span>
								<span className="mm-line">
									<span className="mm-id">{m.id}</span>
									<span className="mm-meta" title="Context window">{formatTokens(m.contextWindow)} context</span>
								</span>
							</button>
						</li>
					);
				})}
			</ul>
			{footer && <div className="mm-foot">{footer}</div>}
		</>
	);
}

export function levelName(level: string): string {
	if (level === "xhigh") return "Extra high";
	return level.charAt(0).toUpperCase() + level.slice(1);
}

export function ThinkingMenuList({
	levels,
	effectiveLevel,
	onPick,
	empty,
	footer,
}: {
	levels: string[];
	effectiveLevel: string | undefined;
	onPick: (level: string) => void;
	empty?: string;
	footer?: string;
}) {
	return (
		<>
			{levels.length === 0 ? (
				<div className="mm-note">{empty ?? "No thinking levels."}</div>
			) : (
				levels.map((level) => (
					<button
						key={level}
						type="button"
						data-testid={`thinking-option-${level}`}
						onClick={() => onPick(level)}
						className={level === effectiveLevel ? "mm-row on" : "mm-row"}
					>
						<span className="flex-1">{levelName(level)}</span>
						{level === effectiveLevel && <Icon name="check" size="sm" className="tick" />}
					</button>
				))
			)}
			{footer && <div className="mm-foot">{footer}</div>}
		</>
	);
}

export function ProviderMenuList({
	providers,
	onPick,
}: {
	providers: { id: string; envVar: string; label: string }[];
	onPick: (provider: { id: string; envVar: string; label: string }) => void;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);

	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const results = providers
		.map((p) => ({ p, s: fuzzyScore(query, p.id, p.envVar, p.label) }))
		.filter((r) => r.s !== null)
		.sort((a, b) => b.s! - a.s! || a.p.id.localeCompare(b.p.id))
		.map((r) => r.p);

	return (
		<>
			<MenuSearch
				ref={searchRef}
				data-testid="provider-search"
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setMenuIdx(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						e.stopPropagation();
						if (results.length === 0) return;
						setMenuIdx((i) =>
							e.key === "ArrowDown"
								? Math.min((i ?? -1) + 1, results.length - 1)
								: Math.max((i ?? results.length) - 1, 0),
						);
					} else if (e.key === "Enter") {
						const chosen = results[menuIdx ?? 0];
						if (chosen) {
							e.preventDefault();
							e.stopPropagation();
							onPick(chosen);
						}
					}
				}}
				placeholder="Search providers…"
			/>
			{results.length === 0 && <div className="mm-note">No providers match.</div>}
			<ul ref={listRef} data-testid="provider-list" className="mm-list">
				{results.map((p, i) => (
					<li key={p.id}>
						<button
							type="button"
							data-testid={`provider-option-${p.id.replace(/[^a-z0-9-]/gi, "_")}`}
							data-idx={i}
							onClick={() => onPick(p)}
							className={i === menuIdx ? "mm-row walk" : "mm-row"}
						>
							<span className="mm-name flex-1">
								<span>{p.label}</span>
							</span>
							<span className="mm-id">{p.envVar}</span>
						</button>
					</li>
				))}
			</ul>
		</>
	);
}

export function fontMenuResults(query: string, families: string[]): Array<string | null> {
	const scored = families
		.map((f) => ({ f, s: fuzzyScore(query, f) }))
		.filter((r) => r.s !== null)
		.sort((a, b) => b.s! - a.s! || a.f.localeCompare(b.f))
		.map((r) => r.f);
	const defaultScore = fuzzyScore(query, "Source Sans 3", "default", "Literata");
	if (query.trim() === "" || defaultScore !== null) return [null, ...scored];
	return scored;
}

export function customFamilyFor(query: string, families: string[]): string | null {
	const trimmed = query.trim();
	if (trimmed === "") return null;
	return fontMenuResults(query, families).length === 0 ? trimmed : null;
}

export function FontMenuList({
	families,
	effectiveFamily,
	onPick,
	footer,
}: {
	families: string[] | undefined;
	effectiveFamily: string | null;
	onPick: (family: string | null) => void;
	footer?: string;
}) {
	const [query, setQuery] = useState("");
	const [menuIdx, setMenuIdx] = useState<number | null>(null);
	const searchRef = useRef<HTMLInputElement>(null);
	const listRef = useRef<HTMLUListElement>(null);

	useEffect(() => {
		searchRef.current?.focus();
	}, []);

	useEffect(() => {
		if (menuIdx === null) return;
		listRef.current?.querySelector(`[data-idx="${menuIdx}"]`)?.scrollIntoView({ block: "nearest" });
	}, [menuIdx]);

	const results = fontMenuResults(query, families ?? []);
	const customFamily = customFamilyFor(query, families ?? []);
	const walkable: Array<string | null> = customFamily !== null ? ["__custom__"] : results;

	return (
		<>
			<MenuSearch
				ref={searchRef}
				data-testid="font-search"
				value={query}
				onChange={(e) => {
					setQuery(e.target.value);
					setMenuIdx(null);
				}}
				onKeyDown={(e) => {
					if (e.key === "ArrowDown" || e.key === "ArrowUp") {
						e.preventDefault();
						e.stopPropagation();
						if (walkable.length === 0) return;
						setMenuIdx((i) =>
							e.key === "ArrowDown"
								? Math.min((i ?? -1) + 1, walkable.length - 1)
								: Math.max((i ?? walkable.length) - 1, 0),
						);
					} else if (e.key === "Enter") {
						const chosen = walkable[menuIdx ?? 0];
						if (chosen !== undefined) {
							e.preventDefault();
							e.stopPropagation();
							onPick(chosen === "__custom__" ? customFamily : chosen);
						}
					}
				}}
				placeholder="Search fonts…"
			/>
			{!families && <div className="mm-note">Loading fonts…</div>}
			<ul ref={listRef} data-testid="font-list" className="mm-list">
				{families &&
					results.map((family, i) => {
						const isDefault = family === null;
						const effective = isDefault ? effectiveFamily === null : family === effectiveFamily;
						return (
							<li key={family ?? "__default"}>
								<button
									type="button"
									data-testid={isDefault ? "font-option-default" : `font-option-${family.replace(/[^a-z0-9-]/gi, "_")}`}
									data-idx={i}
									onClick={() => onPick(family)}
									className={`mm-row${i === menuIdx ? " walk" : ""}${effective ? " on" : ""}${effective && i !== menuIdx ? " bg-muted/60" : ""}`}
								>
									<span className="mm-name flex-1">
										<span>{family ?? "Literata"}</span>
									</span>
									{isDefault && <span className="mm-meta">default</span>}
									{effective && <Icon name="check" size="sm" className="tick" />}
								</button>
							</li>
						);
					})}
				{families && customFamily !== null && (
					<li>
						<button
							type="button"
							data-testid="font-option-custom"
							data-idx={0}
							onClick={() => onPick(customFamily)}
							className={menuIdx === 0 ? "mm-row walk" : "mm-row"}
						>
							<span className="mm-name flex-1">
								<span>Use “{customFamily}”</span>
							</span>
							<span className="mm-meta">custom</span>
						</button>
					</li>
				)}
			</ul>
			{footer && <div className="mm-foot">{footer}</div>}
		</>
	);
}
