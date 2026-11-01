/**
 * Replay the current graph through the incremental layout one
 * imported-notes file at a time. Writes ONLY data/graph/positions.json.
 *
 *   npx tsx scripts/replay-layout.ts [--depth=vertical|radial]
 */
import { graphStore } from "../src/store/graph.ts";
const depthArg = process.argv.find((a) => a.startsWith("--depth="));
const depthMode: "off" | "vertical" | "radial" =
	depthArg === "--depth=vertical" ? "vertical" : depthArg === "--depth=radial" ? "radial" : "off";
import { incrementalLayout } from "../src/core/layout.ts";
import { birthSessionPartition } from "../src/core/session-clusters.ts";
import { deriveView, getGraph } from "../src/core/graph.ts";
import type { GraphNode, Position } from "../src/core/contracts.ts";

function main() {
	const t0 = Date.now();

	const graph = getGraph(graphStore);
	const nodes = graph.nodes;
	const view = deriveView(graph);
	const edges = view.edges;
	const logicalEdges = view.logicalEdges;
	const impLinks = view.impLinks;
	const viewNodeById = new Map(view.nodes.map((n) => [n.id, n]));
	const chains = graph.chains;
	const chainReady = (id: string): boolean => {
		const chain = chains.find((c) => c.id === id);
		if (!chain) return delivered.has(id);
		return delivered.has(chain.conclusion) && chain.premises.every((p) => delivered.has(p));
	};
	const birthClusters = birthSessionPartition(nodes);

	const sources = [...graphStore.readSources()].sort((a, b) => a.importedAt.localeCompare(b.importedAt));
	const batchOf = new Map<string, string>();
	for (const node of nodes) {
		const birth = node.provenance[0]?.chatId;
		if (birth !== undefined && !batchOf.has(node.id)) batchOf.set(node.id, birth);
	}

	const delivered = new Set<string>();
	let positions = new Map<string, Position>(Object.entries(graphStore.readPositions()));
	if (positions.size > 0) {
		console.log("[replay] discarding existing positions ledger — full replay from empty");
		positions = new Map();
	}

	const byId = new Map(nodes.map((n) => [n.id, n]));
	const unmappedFallback = sources[sources.length - 1]?.id ?? "";

	console.log(`[replay] ${nodes.length} nodes, ${chains.length} chains, ${sources.length} sources`);
	let maxOldShift = 0;
	let shiftReport = "";
	for (const source of sources) {
		const batch = nodes.filter((n) => batchOf.get(n.id) === source.id);
		const isLast = source.id === sources[sources.length - 1]!.id;
		if (isLast) {
			for (const n of nodes) {
				if (!batchOf.has(n.id) && !delivered.has(n.id)) {
					batch.push(n);
					batchOf.set(n.id, unmappedFallback);
				}
			}
		}
		for (const n of batch) delivered.add(n.id);
		for (const chain of chains) {
			if (chainReady(chain.id)) delivered.add(chain.id);
		}

		const activeEdges = edges.filter((e) => delivered.has(e.from) && delivered.has(e.to));
		const activeLogical = logicalEdges.filter((e) => delivered.has(e.from) && delivered.has(e.to));

		const before = new Map(positions);
		const batchNodes = view.nodes.filter((n) => delivered.has(n.id));
		positions = incrementalLayout(batchNodes, activeEdges, positions, {
			clusters: birthClusters
				.map((c) => ({ members: c.members.filter((id) => delivered.has(id)) }))
				.filter((c) => c.members.length > 0),
			...(depthMode === "off"
				? {}
				: {
						depthAnchor: {
							mode: depthMode,
							strength: 0.8,
							spacing: 60,
							...(depthMode === "radial" ? { baseRadius: 220 } : {}),
						},
						logicalEdges: activeLogical,
						impLinks: impLinks.filter((l) => delivered.has(l.id)),
					}),
		});
		for (const [id, prev] of before) {
			const now = positions.get(id)!;
			const shift = Math.hypot(prev.x - now.x, prev.y - now.y);
			if (shift > maxOldShift) {
				maxOldShift = shift;
				shiftReport = `${id} ${prev.x.toFixed(0)},${prev.y.toFixed(0)} -> ${now.x.toFixed(0)},${now.y.toFixed(0)} (batch ${batch.length} new, ${activeEdges.length} edges)`;
			}
		}
		const label = source.filePath.split("/").pop() ?? source.id;
		console.log(
			`[replay] +${String(batch.length).padStart(3)} nodes  ${String(activeEdges.length).padStart(4)} edges active  (${label})`,
		);
	}

	graphStore.writePositions(Object.fromEntries(positions));
	console.log(
		`[replay] done: ${positions.size} positions written in ${((Date.now() - t0) / 1000).toFixed(1)}s` +
			` (max old-node shift within a batch: ${maxOldShift.toFixed(1)}: ${shiftReport})`,
	);
}

main();