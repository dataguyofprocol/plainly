"use client"

import * as React from "react"
import { Tooltip, TooltipProvider, TooltipTrigger, TooltipContent } from "@/components/ui/tooltip"
import { bindingForAction, formatBinding, type KeyAction } from "@/src/core"

/**
 * children must be a single element able to take a ref (TooltipTrigger
 * asChild merges onto it).
 */

interface HintProps {
	label: string
	action?: KeyAction
	binding?: string
	side?: "top" | "bottom" | "left" | "right"
	children: React.ReactElement
}

export function hintText(label: string, action?: KeyAction, binding?: string): string {
	const live = action
		? formatBinding(bindingForAction(action))
		: binding
			? formatBinding(binding)
			: ""
	return live ? `${label} (${live})` : label
}

export function Hint({ label, action, binding, side = "top", children }: HintProps) {
	const live = action ? formatBinding(bindingForAction(action)) : binding ? formatBinding(binding) : ""
	return (
		<TooltipProvider>
			<Tooltip>
				<TooltipTrigger asChild>{children}</TooltipTrigger>
				<TooltipContent side={side} aria-label={hintText(label, action, binding)}>
					{label}
					{live && (
						<kbd className="inline-flex h-4 min-w-4 items-center justify-center rounded-[4px] bg-primary-foreground/15 px-1 font-sans text-xs leading-none font-semibold text-primary-foreground/85">
							{live}
						</kbd>
					)}
				</TooltipContent>
			</Tooltip>
		</TooltipProvider>
	)
}