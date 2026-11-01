import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renameSessionsPatch, seedMissingNodePositions } from "../components/graph-view.tsx";

const snapshot = (): {
	sessions: Record<string, string>;
	fileSources: Record<string, string>;
	clusters: { id: string; label: string | null; members: string[] }[];
	nodes: { id: string }[];
	edges: never[];
	nodeSessions: Record<string, string[]>;
	nodeObservations: Record<string, Record<string, string>>;
} => ({
	sessions: { chat_a: "Old title", seedplan: "Orbital mechanics" },
	fileSources: {},
	clusters: [
		{ id: "chat_a", label: "Old title", members: ["n1"] },
		{ id: "chat_b", label: null, members: ["n2"] },
	],
	nodes: [{ id: "n1" }, { id: "n2" }],
	edges: [],
	nodeSessions: {},
	nodeObservations: {},
});

describe("renameSessionsPatch (in-place, identity-preserving)", () => {
	it("writes the title into the sessions map and keeps EVERY object identity", () => {
		const snap = snapshot();
		const sessionsRef = snap.sessions;
		const clustersRef = snap.clusters;
		renameSessionsPatch(snap, "chat_a", "New title");
		assert.equal(snap.sessions.chat_a, "New title");
		assert.equal(snap.sessions, sessionsRef, "sessions map identity preserved");
		assert.equal(snap.clusters, clustersRef, "clusters array identity preserved");
		assert.equal(snap.clusters[0]!.label, "Old title", "react-side cluster label untouched (renderer channel owns it)");
	});

	it("adds an unknown session id harmlessly (renames outside the graph)", () => {
		const snap = snapshot();
		renameSessionsPatch(snap, "chat_other", "Some other chat");
		assert.equal(snap.sessions.chat_other, "Some other chat");
		assert.equal(snap.sessions.chat_a, "Old title");
	});
});

describe("seedMissingNodePositions (ledger stragglers)", () => {
	const positions = (): Map<string, { x: number; y: number }> =>
		new Map([
			["n1", { x: -100, y: 0 }],
			["n2", { x: 100, y: 40 }],
		]);

	it("known positions are byte-identical; missing nodes are seeded off the origin", () => {
		const nodes = [{ id: "n1" }, { id: "n2" }, { id: "n_new" }, { id: "n_newer" }];
		const out = seedMissingNodePositions(nodes, positions());
		assert.equal(out.get("n1"), out.get("n1"));
		assert.equal(out.get("n1")!.x, -100);
		assert.equal(out.get("n2")!.y, 40);
		assert.equal(out.size, 4);
		for (const id of ["n_new", "n_newer"]) {
			const p = out.get(id)!;
			assert.ok(p.x !== 0 || p.y !== 0, `${id} not at the origin`);
		}
	});

	it("deterministic across runs (same ids → same ring spots)", () => {
		const nodes = [{ id: "n1" }, { id: "n2" }, { id: "n_new" }];
		const a = seedMissingNodePositions(nodes, positions());
		const b = seedMissingNodePositions(nodes, positions());
		assert.deepEqual(
			[...a.entries()].map(([id, p]) => [id, p.x, p.y]),
			[...b.entries()].map(([id, p]) => [id, p.x, p.y]),
		);
	});

	it("seeds land on the ring around the centroid (off the known mass)", () => {
		const nodes = [{ id: "n1" }, { id: "n2" }, { id: "n_new" }];
		const out = seedMissingNodePositions(nodes, positions());
		const p = out.get("n_new")!;
		const dist = Math.hypot(p.x - 0, p.y - 20);
		assert.ok(Math.abs(dist - 160) < 1e-9, `seed on the 160-unit ring, got ${dist}`);
	});

	it("nothing missing → the map comes back untouched (early exit)", () => {
		const pos = positions();
		const out = seedMissingNodePositions([{ id: "n1" }, { id: "n2" }], pos);
		assert.equal(out, pos);
		assert.equal(out.size, 2);
	});

	it("empty known map → early exit (the bootstrap fallback owns that case)", () => {
		const pos = new Map<string, { x: number; y: number }>();
		const out = seedMissingNodePositions([{ id: "n1" }], pos);
		assert.equal(out.size, 0);
	});
});
