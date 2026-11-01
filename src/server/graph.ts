import * as fs from "node:fs";
import { LEDGER_FILES, POSITIONS_FILE } from "../../config.ts";
import type { GraphSnapshot } from "../core/contracts.ts";
import type { GraphCostSummary } from "../core/cost-summary.ts";
import { graphCostSummary } from "../core/cost-summary.ts";
import { graphSnapshot } from "../core/graph.ts";
import { birthSessionPartition } from "../core/session-clusters.ts";
import {
	deleteNodeTraces,
	type NodeDeletionStats,
} from "../core/graph-deletion.ts";
import { extractionStatuses } from "../agent/subagents/extraction.ts";
import { stores } from "./stores.ts";
import { callCost } from "./pricing.ts";

export function graphView(): GraphSnapshot {
	return graphSnapshot(stores);
}

export function graphCosts(): GraphCostSummary {
	const chats = stores.chatStore
		.listChats()
		.flatMap((summary) => {
			const record = stores.chatStore.getChat(summary.id);
			return record?.extractions?.length
				? [{ title: record.title ?? summary.id, extractions: record.extractions }]
				: [];
		});
	const sources = stores.graphStore
		.readSources()
		.filter((s) => s.extractions?.length)
		.map((s) => ({ filePath: s.filePath, extractions: s.extractions! }));
	return graphCostSummary({ chats, sources }, callCost);
}

export function graphRevision(): number {
	let revision = 0;
	for (const file of [
		LEDGER_FILES.nodes,
		LEDGER_FILES.chains,
		LEDGER_FILES.sessions,
		LEDGER_FILES.coverage,
		POSITIONS_FILE,
	]) {
		try {
			revision = Math.max(revision, fs.statSync(file).mtimeMs);
		} catch {
			/* absent — nothing has ever written it */
		}
	}
	return revision;
}

export type NodeDeleteOutcome =
	| { ok: false; status: 404; code: "not_found"; error: string }
	| { ok: false; status: 409; code: "extraction_running"; error: string }
	| { ok: true; stats: NodeDeletionStats; graphRevision: number };

export function deleteGraphNode(nodeId: string): NodeDeleteOutcome {
	if (extractionStatuses().length > 0) {
		return {
			ok: false,
			status: 409,
			code: "extraction_running",
			error: "An extraction is running — try again when it finishes",
		};
	}
	const stats = deleteNodeTraces(stores.graphStore, nodeId);
	if (stats === null) {
		return { ok: false, status: 404, code: "not_found", error: "No such node" };
	}
	return { ok: true, stats, graphRevision: graphRevision() };
}

