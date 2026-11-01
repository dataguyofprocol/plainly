export interface PlanNode {
	/** Agent-chosen slug, stable across rewrites. */
	id: string;
	title: string;
	summary?: string;
}

export interface PlanEdge {
	/** Prerequisite node id. */
	from: string;
	/** Node that depends on `from`. */
	to: string;
}

export interface PlanTree {
	nodes: PlanNode[];
	edges: PlanEdge[];
	version: number;
}

/** Derived, never stored. */
export type PlanNodeStatus = "current" | "visited" | "upcoming";

interface PartsCarrier {
	parts: Array<{ type: string; state?: string; input?: unknown; output?: unknown }>;
}

export interface DerivedPlanStatuses {
	/** The node the most recent tagged quiz call is about; null before any. */
	current: string | null;
	/** Nodes of earlier stays; a revisited node is in both visited and current. */
	visited: ReadonlySet<string>;
}

export function derivedNodeStatus(statuses: DerivedPlanStatuses, nodeId: string): PlanNodeStatus {
	if (statuses.current === nodeId) return "current";
	if (statuses.visited.has(nodeId)) return "visited";
	return "upcoming";
}

/** Position comes from quiz/explain CALLS only, never results. Node ids
 *  missing from the tree are ignored. */
export function derivePlanStatuses(tree: PlanTree, messages: readonly PartsCarrier[]): DerivedPlanStatuses {
	const ids = new Set(tree.nodes.map((n) => n.id));
	const runs: string[] = [];
	for (const m of messages) {
		for (const part of m.parts) {
			if (part.type !== "tool-quiz" && part.type !== "tool-explain") continue;
			const nodeId = (part.input as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string" || !ids.has(nodeId)) continue;
			if (runs.at(-1) !== nodeId) runs.push(nodeId);
		}
	}
	const current = runs.at(-1) ?? null;
	const visited = new Set(runs.slice(0, -1));
	return { current, visited };
}

export interface PlanToolResult {
	ok: boolean;
	error?: string;
	/** Success results only. Never sent to the agent. */
	tree?: PlanTree;
}

import type { LhMessage } from "../native-messages.ts";

/** derivePlanStatuses over native messages; a dangling call still moves position. */
export function derivePlanStatusesLh(tree: PlanTree, messages: readonly LhMessage[]): DerivedPlanStatuses {
	const ids = new Set(tree.nodes.map((n) => n.id));
	const runs: string[] = [];
	for (const m of messages) {
		if ((m as { role?: string }).role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
			if (block.type !== "toolCall" || (block.name !== "quiz" && block.name !== "explain")) continue;
			const nodeId = (block.arguments as { nodeId?: unknown } | undefined)?.nodeId;
			if (typeof nodeId !== "string" || !ids.has(nodeId)) continue;
			if (runs.at(-1) !== nodeId) runs.push(nodeId);
		}
	}
	const current = runs.at(-1) ?? null;
	const visited = new Set(runs.slice(0, -1));
	return { current, visited };
}
