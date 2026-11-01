import { chatStore } from "../store/chats.ts";
import { graphStore } from "../store/graph.ts";
import { jobStore } from "../store/jobs.ts";
import { settingsStore } from "../store/settings.ts";
import { resolveSettings, type EffectiveSettings } from "../core/settings-resolution.ts";
export const stores = {
	chatStore,
	graphStore,
	jobStore,
	settingsStore,
};

export type Stores = typeof stores;

export function effectiveSettings(): EffectiveSettings {
	return resolveSettings(settingsStore.readSettings());
}
