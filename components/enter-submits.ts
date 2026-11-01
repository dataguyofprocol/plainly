"use client";

import { useEffect, useRef } from "react";
import { isTypingSurface } from "@/src/core";

const OVERLAY_ROOTS = '[data-lh-menu], [data-radix-popper-content-wrapper], [role="menu"], [role="dialog"]';

export function buttonKeepsNativeEnter(el: HTMLElement): boolean {
	// (Guarded: a selector engine without the pseudo — linkedom in the
	// test harness — degrades to "not keyboard focus", never throws on
	// every Enter.)
	try {
		if (el.matches(":focus-visible")) return true;
	} catch {
		// unsupported pseudo — treat as pointer focus
	}
	return !!el.closest(OVERLAY_ROOTS);
}

export function useEnterSubmits(submit: () => void): void {
	const submitRef = useRef(submit);
	submitRef.current = submit;
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Enter") return;
			if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
			if (isTypingSurface(e)) return;
			const target = e.target as HTMLElement | null;
			if (target?.tagName === "BUTTON" && buttonKeepsNativeEnter(target)) return;
			e.preventDefault();
			submitRef.current();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);
}
