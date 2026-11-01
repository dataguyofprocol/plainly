"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";

const GAP = 4;
const EDGE = 8;
const CAP_VH = 0.6;
const MIN_USABLE = 96;

export const MENU_OPEN_EVENT = "lh:menu-open";
export const MENU_CLOSE_EVENT = "lh:menu-close";

export type MenuSide = "up" | "down";
export type MenuAlign = "left" | "right";

export interface MenuPlacement {
	side: MenuSide;
	style: Record<string, string | number>;
	maxHeight: number;
}

export function computeMenuPlacement(
	rect: { top: number; bottom: number; left: number; right: number },
	viewport: { width: number; height: number },
	contentHeight: number,
	preferredSide: MenuSide,
	align: MenuAlign,
): MenuPlacement {
	const availDown = viewport.height - EDGE - (rect.bottom + GAP);
	const availUp = rect.top - GAP - EDGE;
	let side = preferredSide;
	if (contentHeight > 0) {
		const preferredAvail = preferredSide === "down" ? availDown : availUp;
		const otherAvail = preferredSide === "down" ? availUp : availDown;
		if (contentHeight > preferredAvail && otherAvail > preferredAvail) {
			side = preferredSide === "down" ? "up" : "down";
		}
	}
	const avail = side === "down" ? availDown : availUp;
	const maxHeight = Math.max(MIN_USABLE, Math.min(CAP_VH * viewport.height, avail));
	const horizontal: Record<string, number> =
		align === "right" ? { right: viewport.width - rect.right } : { left: rect.left };
	const vertical: Record<string, number> =
		side === "down" ? { top: rect.bottom + GAP } : { bottom: viewport.height - rect.top + GAP };
	return { side, style: { ...horizontal, ...vertical }, maxHeight };
}

export function MenuShell({
	anchorRef,
	anchorTestid,
	testid,
	preferredSide,
	align = "right",
	menuClass,
	children,
}: {
	anchorRef?: RefObject<HTMLElement | null>;
	anchorTestid?: string;
	testid: string;
	preferredSide: MenuSide;
	align?: MenuAlign;
	menuClass: string;
	children: ReactNode;
}) {
	const menuRef = useRef<HTMLDivElement>(null);
	const [placed, setPlaced] = useState<MenuPlacement | null>(null);
	const focusedOnceRef = useRef(false);

	useEffect(() => {
		window.dispatchEvent(new CustomEvent(MENU_OPEN_EVENT));
		return () => {
			window.dispatchEvent(new CustomEvent(MENU_CLOSE_EVENT));
		};
	}, []);

	// The lists' own mount focus runs during the hidden measuring pass, where
	// focus() silently fails (visibility: hidden subtrees are not focusable).
	useEffect(() => {
		if (placed === null || focusedOnceRef.current) return;
		focusedOnceRef.current = true;
		const el = menuRef.current;
		if (!el) return;
		const input = el.querySelector<HTMLElement>("input");
		(input ?? el).focus();
	}, [placed]);

	const onBodyKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		const { key } = e;
		if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "Home" && key !== "End") return;
		const buttons = Array.from(
			menuRef.current?.querySelectorAll<HTMLElement>("button:not([disabled])") ?? [],
		);
		if (buttons.length === 0) return;
		e.preventDefault();
		if (key === "Home") {
			buttons[0]?.focus();
			return;
		}
		if (key === "End") {
			buttons[buttons.length - 1]?.focus();
			return;
		}
		const delta = key === "ArrowDown" ? 1 : -1;
		const idx = buttons.findIndex((b) => b === document.activeElement);
		const base = idx === -1 ? (delta > 0 ? -1 : 0) : idx;
		const next = (base + delta + buttons.length) % buttons.length;
		buttons[next]?.focus();
	};

	const anchor = () => {
		if (anchorRef) return anchorRef.current;
		if (anchorTestid !== undefined) return document.querySelector(`[data-testid="${anchorTestid}"]`);
		return null;
	};

	useLayoutEffect(() => {
		let raf = 0;
		const place = () => {
			const el = anchor();
			if (!el || !menuRef.current) return;
			const p = computeMenuPlacement(
				el.getBoundingClientRect(),
				{ width: window.innerWidth, height: window.innerHeight },
				menuRef.current.scrollHeight,
				preferredSide,
				align,
			);
			setPlaced(p);
		};
		place();
		const rePlace = () => {
			cancelAnimationFrame(raf);
			raf = requestAnimationFrame(place);
		};
		window.addEventListener("scroll", rePlace, true);
		window.addEventListener("resize", rePlace);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("scroll", rePlace, true);
			window.removeEventListener("resize", rePlace);
		};
	}, [anchorRef, anchorTestid, preferredSide, align]);

	if (placed === null) {
		return createPortal(
			<div className="v4 scope">
				<div
					ref={menuRef}
					data-testid={testid}
					data-lh-menu=""
					style={{ position: "fixed", left: 0, top: 0, visibility: "hidden" }}
					className={menuClass}
				>
					{children}
				</div>
			</div>,
			document.body,
		);
	}
	return createPortal(
		<div className="v4 scope">
			<div
				ref={menuRef}
				data-testid={testid}
				data-lh-menu=""
				tabIndex={-1}
				onKeyDown={onBodyKeyDown}
				style={{ position: "fixed", zIndex: 60, ...placed.style, maxHeight: placed.maxHeight, overflowY: "auto" }}
				className={`${menuClass} outline-none`}
			>
				{children}
			</div>
		</div>,
		document.body,
	);
}