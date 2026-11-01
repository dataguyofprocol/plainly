import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ideaNeighbours } from "../components/graph-view.tsx";

describe("ideaNeighbours", () => {
	const chains = [
		{ premises: ["a", "b"], conclusion: "x" },
		{ premises: ["b"], conclusion: "x" },
		{ premises: ["x", "c"], conclusion: "y" },
		{ premises: ["x"], conclusion: "z" },
	];

	it("rests on: every premise of chains concluding at it, deduplicated", () => {
		assert.deepEqual(ideaNeighbours(chains, "x").restsOn, ["a", "b"]);
	});

	it("leads to: every conclusion it is a premise of", () => {
		assert.deepEqual(ideaNeighbours(chains, "x").leadsTo, ["y", "z"]);
	});

	it("a starting point rests on nothing; a leaf leads nowhere", () => {
		assert.deepEqual(ideaNeighbours(chains, "a"), { restsOn: [], leadsTo: ["x"] });
		assert.deepEqual(ideaNeighbours(chains, "z"), { restsOn: ["x"], leadsTo: [] });
	});

	it("a self-referencing chain never lists the idea as its own neighbour", () => {
		assert.deepEqual(ideaNeighbours([{ premises: ["x", "a"], conclusion: "x" }], "x"), { restsOn: ["a"], leadsTo: [] });
	});
});
