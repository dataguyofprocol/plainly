/**
 * Binding strings: "mod+shift+f", "alt+arrowdown", "?", "f2". mod is ⌘ or
 * Ctrl. Order is fixed: mod, alt, shift, then the key.
 */

export type KeyAction =
	| "toggle-dictation"
	| "open-omnibar"
	| "open-model-picker"
	| "cycle-thinking"
	| "toggle-sidebar"
	| "sessions-search"
	| "jump-graph"
	| "new-session"
	| "rename-session"
	| "cheat-sheet"
	| "find"
	| "question-focus"
	| "question-next-row"
	| "question-prev-row"
	| "question-pick-row"
	| "question-submit"
	| "open-settings"
	| "toggle-user-thinking";

/** Cheat-sheet grouping only; dispatch is global. */
export type KeyScope = "global" | "chat" | "graph";

export interface KeyActionDef {
	id: KeyAction;
	label: string;
	scope: KeyScope;
	binding: string;
	/** Never dispatched from the registry; the owning surface handles the key. */
	displayOnly?: boolean;
}

export const KEYBOARD_ACTIONS: readonly KeyActionDef[] = [
	{ id: "toggle-dictation", label: "Toggle dictation", scope: "global", binding: "mod+d" },
	{ id: "open-settings", label: "Open settings", scope: "global", binding: "mod+," },
	{ id: "open-omnibar", label: "Search and start", scope: "global", binding: "mod+k" },
	{ id: "open-model-picker", label: "Model selector", scope: "global", binding: "mod+shift+m" },
	{ id: "cycle-thinking", label: "Cycle thinking level", scope: "global", binding: "shift+tab" },
	{ id: "toggle-sidebar", label: "Expand or collapse the sidebar", scope: "global", binding: "mod+b" },
	{ id: "sessions-search", label: "Search sessions", scope: "global", binding: "mod+shift+f" },
	{ id: "jump-graph", label: "Knowledge graph", scope: "global", binding: "mod+g" },
	{ id: "new-session", label: "New session", scope: "global", binding: "mod+n" },
	{ id: "rename-session", label: "Rename session", scope: "chat", binding: "f2" },
	{ id: "toggle-user-thinking", label: "Toggle all your thinking", scope: "chat", binding: "mod+t" },
	{ id: "find", label: "Find", scope: "global", binding: "mod+f" },
	{ id: "cheat-sheet", label: "Shortcut cheat sheet", scope: "global", binding: "?" },
	{ id: "question-focus", label: "Question · focus thinking ↔ rows", scope: "chat", binding: "tab", displayOnly: true },
	{ id: "question-next-row", label: "Question · next row", scope: "chat", binding: "arrowdown", displayOnly: true },
	{ id: "question-prev-row", label: "Question · previous row", scope: "chat", binding: "arrowup", displayOnly: true },
	{ id: "question-pick-row", label: "Question · pick row", scope: "chat", binding: "space", displayOnly: true },
	{ id: "question-submit", label: "Question · submit", scope: "chat", binding: "enter", displayOnly: true },
];

const STORAGE_KEY = "lh:keymap";

export function loadOverrides(): Partial<Record<KeyAction, string>> {
	if (typeof window === "undefined") return {};
	try {
		const raw = window.localStorage.getItem(STORAGE_KEY);
		if (!raw) return {};
		const parsed = JSON.parse(raw) as Partial<Record<KeyAction, string>>;
		if (parsed && typeof parsed === "object") return parsed;
	} catch {
	}
	return {};
}

/** An empty map clears the stored overrides. */
export function saveOverrides(overrides: Partial<Record<KeyAction, string>>): void {
	if (typeof window === "undefined") return;
	try {
		if (Object.keys(overrides).length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
		else window.localStorage.removeItem(STORAGE_KEY);
	} catch {
	}
}

export function effectiveKeymap(): Map<string, KeyAction> {
	const overrides = loadOverrides();
	const map = new Map<string, KeyAction>();
	for (const def of KEYBOARD_ACTIONS) {
		if (def.displayOnly) continue;
		const binding = overrides[def.id] ?? def.binding;
		if (typeof binding === "string" && binding) map.set(binding, def.id);
	}
	return map;
}

export function actionForBinding(binding: string): KeyAction | undefined {
	return effectiveKeymap().get(binding);
}

export function bindingForAction(id: KeyAction): string {
	const overrides = loadOverrides();
	const def = KEYBOARD_ACTIONS.find((a) => a.id === id);
	if (!def) return "";
	return overrides[id] ?? def.binding;
}

/** mod matches both meta and ctrl. A bare printable key bakes its shift into
 *  the character ("?", not "shift+/"); other keys keep an explicit shift. */
export function eventBinding(e: KeyboardEvent): string {
	const mod = e.metaKey || e.ctrlKey;
	if (e.key.length === 1 && !mod && !e.altKey) return e.key.toLowerCase();
	const mods: string[] = [];
	if (mod) mods.push("mod");
	if (e.altKey) mods.push("alt");
	if (e.shiftKey) mods.push("shift");
	return [...mods, e.key.toLowerCase()].join("+");
}

/** The dispatcher and every surface listener must build the event name here. */
export function kbdEventForAction(action: KeyAction): string {
	return `lh:kbd-${action}`;
}

export function isTypingSurface(e: KeyboardEvent): boolean {
	const target = e.target as HTMLElement | null;
	if (!target) return false;
	const tag = target.tagName;
	if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
	return target.isContentEditable;
}

export const IS_MAC =
	typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent);

const MOD_GLYPH = IS_MAC ? "⌘" : "Ctrl+";
const ALT_GLYPH = IS_MAC ? "⌥" : "Alt+";
const SHIFT_GLYPH = IS_MAC ? "⇧" : "Shift+";

const KEY_GLYPH: Record<string, string> = {
	arrowup: "↑",
	arrowdown: "↓",
	arrowleft: "←",
	arrowright: "→",
	enter: "↵",
	tab: "⇥",
	escape: "Esc",
	space: "Space",
};

export function formatBinding(binding: string): string {
	const parts = binding.split("+");
	const key = parts.pop()!;
	const glyphs: string[] = [];
	for (const part of parts) {
		if (part === "mod") glyphs.push(MOD_GLYPH);
		else if (part === "alt") glyphs.push(ALT_GLYPH);
		else if (part === "shift") glyphs.push(SHIFT_GLYPH);
	}
	const keyGlyph = KEY_GLYPH[key] ?? key.toUpperCase();
	return glyphs.join("") + keyGlyph;
}
