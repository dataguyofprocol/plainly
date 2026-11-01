import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeMenuPlacement, type MenuSide } from "../components/menu-shell.tsx";

const rect = (top: number, bottom: number) => ({ top, bottom, left: 100, right: 300 });
const viewport = (height: number) => ({ width: 1280, height });

describe("computeMenuPlacement — side", () => {
	it("keeps the preferred side when it shows the whole menu", () => {
		for (const preferred of ["up", "down"] as MenuSide[]) {
			const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, preferred, "right");
			assert.equal(p.side, preferred);
		}
	});

	it("flips when the preferred side cannot hold the content and the other is roomier", () => {
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 300, "down", "right");
		assert.equal(p.side, "up");
		const q = computeMenuPlacement(rect(0, 30), viewport(800), 300, "up", "right");
		assert.equal(q.side, "down");
	});

	it("stays put when neither side fits better (the roomier side already preferred)", () => {
		const p = computeMenuPlacement(rect(150, 190), viewport(650), 600, "down", "right");
		assert.equal(p.side, "down");
	});

	it("nothing measured yet (contentHeight ≤ 0) keeps the preferred side", () => {
		const p = computeMenuPlacement(rect(770, 800), viewport(800), 0, "down", "right");
		assert.equal(p.side, "down");
	});
});

describe("computeMenuPlacement — cap + position", () => {
	it("caps at 60vh when the side has more room than that", () => {
		const p = computeMenuPlacement(rect(100, 140), viewport(800), 300, "down", "right");
		assert.equal(p.maxHeight, 0.6 * 800);
		assert.equal(p.style.top, 144);
		assert.equal(p.style.right, 1280 - 300);
	});

	it("caps at the side's available room when 60vh exceeds it", () => {
		const p = computeMenuPlacement(rect(500, 540), viewport(800), 100, "down", "right");
		assert.equal(p.side, "down");
		assert.equal(p.maxHeight, 248);
	});

	it("never crushes below the usability floor, even against a tiny side", () => {
		const p = computeMenuPlacement(rect(30, 60), viewport(90), 300, "down", "right");
		assert.equal(p.maxHeight, 96);
	});

	it("up-side menus anchor their BOTTOM above the anchor's top", () => {
		const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, "up", "right");
		assert.equal(p.style.bottom, 800 - 400 + 4);
		assert.ok(!("top" in p.style));
	});

	it("left alignment keys off the anchor's left edge", () => {
		const p = computeMenuPlacement(rect(400, 440), viewport(800), 300, "down", "left");
		assert.equal(p.style.left, 100);
		assert.ok(!("right" in p.style));
	});
});