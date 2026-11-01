"use client";

import { DEFAULT_THINKING_ORDER } from "@/src/core";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";

export const THINKING_LABEL: Record<string, string> = {
	off: "off",
	minimal: "minimal",
	low: "low",
	medium: "medium",
	high: "high",
	xhigh: "xhigh",
	max: "max",
};

export function defaultOrderLevel(supported: readonly ThinkingLevel[]): ThinkingLevel {
	for (const level of DEFAULT_THINKING_ORDER) {
		if (supported.includes(level)) return level;
	}
	return supported[0] ?? "off";
}

export function populateLevel(
	explicit: ThinkingLevel | undefined,
	supported: readonly ThinkingLevel[],
): ThinkingLevel {
	return explicit ?? defaultOrderLevel(supported);
}