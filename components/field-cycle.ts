"use client";

import { useEffect } from "react";

export function useFieldCycle(fields: () => readonly HTMLElement[]) {
	useEffect(() => {
		const onCycle = () => {
			const list = fields().filter((el) => el.isConnected);
			if (list.length === 0) return;
			const active = document.activeElement;
			const idx = active ? list.findIndex((el) => el === active || el.contains(active)) : -1;
			if (idx < 0) {
				list[0]!.focus();
				return;
			}
			list[(idx + 1) % list.length]!.focus();
		};
		window.addEventListener("lh:kbd-cycle-fields", onCycle);
		return () => window.removeEventListener("lh:kbd-cycle-fields", onCycle);
	}, [fields]);
}
