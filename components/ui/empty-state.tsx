/**
 * The empty state (finesse pass): an icon well, a title, one line of
 * guidance, and at most one action. Every "nothing here yet" in the app
 * uses it, so emptiness always reads as a next step, not an error.
 * Styles: app/v4.css (.empty*). Renders inside a .v4 scope.
 */

import type { ReactNode } from "react";
import { Icon, type IconName } from "@/components/ui/icon";

export function EmptyState({
	icon,
	title,
	children,
	action,
	align = "center",
	className,
	testid,
}: {
	icon?: IconName;
	title: string;
	children?: ReactNode;
	action?: ReactNode;
	align?: "center" | "left";
	className?: string;
	testid?: string;
}) {
	return (
		<div className={`empty ${align === "left" ? "left" : ""} ${className ?? ""}`} data-testid={testid}>
			{icon && (
				<span className="empty-ic" aria-hidden="true">
					<Icon name={icon} size="lg" />
				</span>
			)}
			<span className="empty-t">{title}</span>
			{children && <span className="empty-d">{children}</span>}
			{action}
		</div>
	);
}
