"use client";
/**
 * The settings control kit: sections → groups (a labelled flat card) →
 * rows (label + description left, one control right). Everything SSRs
 * clean (render tests pin the sections' markup). Styles: app/ui/settings.css.
 *
 * Dependency graying (owner, 2026-09-20) follows the graph viewer's
 * render-panel convention: the WHOLE row dims (opacity-40, label and
 * control together) and the control itself locks — the row owns the dim.
 */

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

/** A section page: title + one line saying what lives here, then groups. */
export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
	/** One line under the title — what this page is for. */
	hint?: string;
	children: React.ReactNode;
	testid?: string;
}) {
	return (
		<section data-testid={testid} className="sd-page">
			<header className="sd-head">
				<h2 className="t-title">{title}</h2>
				{hint && <p>{hint}</p>}
			</header>
			{children}
		</section>
	);
}

/** A labelled group: the label (a <p>, pinned by tests), an optional line
 *  of context, then the rows on one flat card. `bare` drops the card for
 *  groups that lay out their own cards. */
export function SettingsGroup({
	label,
	description,
	children,
	testid,
	bare,
}: {
	label: string;
	description?: string;
	children: React.ReactNode;
	testid?: string;
	bare?: boolean;
}) {
	return (
		<div data-testid={testid} className="st-group">
			<p className="st-glabel">{label}</p>
			{description && <span className="st-gdesc">{description}</span>}
			{bare ? children : <div className="st-card">{children}</div>}
		</div>
	);
}

/** One label + one control. Label left (with an optional description),
 *  control right — the settings row shape. */
export function SettingsRow({
	label,
	hint,
	children,
	testid,
	dimmed,
	mono,
}: {
	label: string;
	hint?: ReactNode;
	children: React.ReactNode;
	testid?: string;
	/** Dependency graying, graph-view style: the whole row dims when the
	 *  control is inert (parent off, no file yet, …). */
	dimmed?: boolean;
	/** The label is a file or identifier, not prose. */
	mono?: boolean;
}) {
	return (
		<div data-testid={testid} className={cn("st-row", dimmed && "opacity-40")}>
			<span className="st-text">
				<span className={cn("st-label", mono && "mono")}>{label}</span>
				{hint && <span className="st-desc">{hint}</span>}
			</span>
			<span className="st-ctl">{children}</span>
		</div>
	);
}

/** The on/off switch — a plain button in the switch role. Token-styled
 *  utilities (not .switch) because it also renders outside .v4 scopes
 *  (the figure and demo cards). */
export function Toggle({
	checked,
	disabled,
	onChange,
	label,
	discIcon,
	title,
}: {
	checked: boolean;
	disabled?: boolean;
	onChange: (next: boolean) => void;
	/** Accessible name for the switch role. */
	label: string;
	/** Optional icon disc (owner round, 2026-10-07): the figure cards' invert
	 *  toggle renders the half-filled contrast circle AS the disc — the icon
	 *  carries the meaning; plain toggles keep the plain disc. */
	discIcon?: ReactNode;
	/** Optional native tooltip on the switch. */
	title?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			{...(title ? { title } : {})}
			disabled={disabled}
			data-testid={`toggle-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-5 w-[34px] shrink-0 rounded-full p-0 transition-colors duration-200",
				checked ? "bg-brand" : "bg-line-strong",
				// The row owns the dim (see the header); the switch only locks.
				disabled ? "cursor-not-allowed" : "cursor-pointer",
			)}
		>
			<span
				className={cn(
					"absolute top-0.5 left-0.5 flex size-4 items-center justify-center rounded-full bg-surface shadow-[0_1px_2px_rgb(from_var(--shadow-ink)_r_g_b/0.24)] transition-transform duration-200",
					checked ? "translate-x-[14px] text-brand" : "translate-x-0 text-muted-foreground",
				)}
			>
				{discIcon}
			</span>
		</button>
	);
}

/** A select-look trigger for the dropdown menus (the shared model/font/
 *  engine menus open from it). Unset reads `emptyLabel` in faint ink. */
export function SelectTrigger({
	value,
	emptyLabel,
	ariaLabel,
	testid,
	open,
	onClick,
	narrow,
	disabled,
	title,
	...rest
}: Omit<React.ComponentProps<"button">, "value" | "onClick" | "title" | "disabled"> & {
	value: string;
	emptyLabel: string;
	ariaLabel: string;
	testid: string;
	open: boolean;
	onClick: () => void;
	/** The thinking trigger's fixed footprint. */
	narrow?: boolean;
	/** Looks inert (whole-row graying) — clicks are ignored. */
	disabled?: boolean;
	/** Full value on hover when it truncates. */
	title?: string;
}) {
	return (
		<button
			// Tooltip triggers (Hint) slot their handlers and ref through here.
			{...rest}
			type="button"
			aria-label={ariaLabel}
			aria-expanded={open}
			data-testid={testid}
			title={title}
			onClick={() => {
				if (!disabled) onClick();
			}}
			className={cn("selectbtn st-select", narrow && "narrow", disabled && "is-off cursor-not-allowed")}
		>
			<span className={value ? undefined : "ph"}>{value || emptyLabel}</span>
			<Icon name="chevrons-up-down" size="sm" />
		</button>
	);
}

/** A thin select — native element, options as given. */
export function ThinSelect({
	value,
	onChange,
	children,
	ariaLabel,
	testid,
	disabled,
}: {
	value: string;
	onChange: (next: string) => void;
	children: React.ReactNode;
	ariaLabel: string;
	testid?: string;
	disabled?: boolean;
}) {
	return (
		<select
			value={value}
			aria-label={ariaLabel}
			data-testid={testid}
			disabled={disabled}
			onChange={(e) => onChange(e.target.value)}
			className={cn("st-nselect", disabled && "cursor-not-allowed")}
		>
			{children}
		</select>
	);
}

/** A thin number/text input committing on blur + Enter (settings pace, not
 *  typing pace — every commit is a section PUT). */
export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
}: {
	/** "" = unset (the factory default). Mirrors the STORED record —
	 *  after a clamped/normalized commit this flows back and the field
	 *  snaps to the stored truth (owner repro: a negative size kept
	 *  displaying "-5" while 12 was stored). */
	value: string;
	placeholder?: string;
	onCommit: (next: string) => void;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
}) {
	// The draft exists only while editing; a blur shows the record's value
	// again — commit-on-blur/Enter (owner ruling), the field honest about
	// what landed.
	const [draft, setDraft] = useState(value);
	const [editing, setEditing] = useState(false);
	return (
		<input
			type={type}
			value={editing ? draft : value}
			placeholder={placeholder}
			aria-label={ariaLabel}
			data-testid={testid}
			onChange={(e) => {
				setEditing(true);
				setDraft(e.target.value);
			}}
			onBlur={() => {
				if (!editing) return;
				setEditing(false);
				const next = draft.trim();
				if (next !== value) onCommit(next);
			}}
			onKeyDown={(e) => {
				if (e.key === "Enter") e.currentTarget.blur();
				if (e.key === "Escape") {
					setEditing(false);
					e.currentTarget.blur();
				}
			}}
			className={cn("finput sm", type === "number" && "st-num")}
		/>
	);
}
