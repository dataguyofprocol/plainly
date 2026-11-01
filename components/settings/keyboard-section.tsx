"use client";

import { useEffect, useState } from "react";
import {
	KEYBOARD_ACTIONS,
	eventBinding,
	formatBinding,
	loadOverrides,
	saveOverrides,
	type KeyAction,
	type KeyScope,
} from "@/src/core";
import { SettingsGroup, SettingsRow } from "./controls.tsx";
import { Icon } from "@/components/ui/icon";

const SCOPES: { scope: KeyScope; label: string }[] = [
	{ scope: "global", label: "Everywhere" },
	{ scope: "chat", label: "In a lesson" },
	{ scope: "graph", label: "On the graph" },
];

export function nextOverrides(
	current: Partial<Record<KeyAction, string>>,
	id: KeyAction,
	binding: string | null,
): Partial<Record<KeyAction, string>> {
	const next = { ...current };
	if (binding === null) delete next[id];
	else next[id] = binding;
	return next;
}

export function bindingParts(text: string): string[] {
	if (text.includes("+") && text.length > 1) return text.split("+").filter(Boolean);
	const parts: string[] = [];
	let rest = text;
	while (rest.length > 1 && "⌘⇧⌥⌃".includes(rest[0]!)) {
		parts.push(rest[0]!);
		rest = rest.slice(1);
	}
	if (rest) parts.push(rest);
	return parts;
}

export function KeyChips({ text, listening }: { text: string; listening?: boolean }) {
	return (
		<span className={listening ? "keys listening" : "keys"} aria-label={text}>
			{bindingParts(text).map((k, i) => (
				<kbd key={i} className="kbd">
					{k}
				</kbd>
			))}
		</span>
	);
}

export function KeyboardSection() {
	const [overrides, setOverrides] = useState<Partial<Record<KeyAction, string>>>({});
	const [rebinding, setRebinding] = useState<KeyAction | null>(null);
	const [nonce, setNonce] = useState(0);

	useEffect(() => {
		setOverrides(loadOverrides());
	}, [nonce]);

	useEffect(() => {
		if (!rebinding) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setRebinding(null);
				return;
			}
			// Modifier keydowns arrive one by one (⌘ down, then ⇧, then the
			// key) — each is a keydown this capture listener sees. They are
			// not bindings; keep listening for the real key.
			if (e.key === "Control" || e.key === "Meta" || e.key === "Alt" || e.key === "Shift") return;
			const binding = eventBinding(e);
			if (!binding) return;
			const next = nextOverrides(loadOverrides(), rebinding, binding);
			saveOverrides(next);
			setRebinding(null);
			setNonce((n) => n + 1);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [rebinding]);

	function resetOne(id: KeyAction) {
		saveOverrides(nextOverrides(loadOverrides(), id, null));
		setNonce((n) => n + 1);
	}

	function resetAll() {
		saveOverrides({});
		setNonce((n) => n + 1);
	}

	const overridden = (id: KeyAction) => overrides[id] !== undefined;

	return (
		<>
			{SCOPES.map(({ scope, label }) => {
				const actions = KEYBOARD_ACTIONS.filter((a) => a.scope === scope);
				if (!actions.length) return null;
				return (
					<SettingsGroup key={scope} label={label} testid={`kbd-scope-${scope}`}>
						{actions.map((def) => {
							const effective = overrides[def.id] ?? def.binding;
							const listening = rebinding === def.id;
							return (
								<SettingsRow
									key={def.id}
									label={def.label}
									hint={def.displayOnly ? "Fixed — part of this screen" : listening ? "Press the new shortcut, or Esc to cancel" : undefined}
									testid={`kbd-row-${def.id}`}
								>
									{def.displayOnly ? null : listening ? (
										<button type="button" onClick={() => setRebinding(null)} className="btn sm quiet">
											Cancel
										</button>
									) : (
										<>
											{overridden(def.id) && (
												<button
													type="button"
													onClick={() => resetOne(def.id)}
													data-testid={`kbd-reset-${def.id}`}
													className="btn sm quiet"
												>
													Reset
												</button>
											)}
											<button
												type="button"
												onClick={() => setRebinding(def.id)}
												data-testid={`kbd-rebind-${def.id}`}
												className="btn sm quiet"
											>
												Change
											</button>
										</>
									)}
									{listening ? (
										<span className="keys listening">
											<kbd className="kbd">Press keys…</kbd>
										</span>
									) : (
										<KeyChips text={formatBinding(effective)} />
									)}
								</SettingsRow>
							);
						})}
					</SettingsGroup>
				);
			})}
			<div className="st-foot">
				<span>
					<Icon name="info" size="xs" />
					Saved on this device. Only your changes are stored.
				</span>
				<button type="button" onClick={resetAll} data-testid="kbd-reset-all" className="btn sm quiet">
					<Icon name="retry" size="xs" />
					Reset all to defaults
				</button>
			</div>
		</>
	);
}
