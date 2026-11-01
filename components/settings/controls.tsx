"use client";

import { useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { Icon } from "@/components/ui/icon";

export function SettingsSection({
	title,
	hint,
	children,
	testid,
}: {
	title: string;
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
	dimmed?: boolean;
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
	label: string;
	discIcon?: ReactNode;
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
	narrow?: boolean;
	disabled?: boolean;
	title?: string;
}) {
	return (
		<button
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

export function CommitInput({
	value,
	placeholder,
	onCommit,
	ariaLabel,
	testid,
	type = "text",
}: {
	value: string;
	placeholder?: string;
	onCommit: (next: string) => void;
	ariaLabel: string;
	testid?: string;
	type?: "text" | "number";
}) {
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
