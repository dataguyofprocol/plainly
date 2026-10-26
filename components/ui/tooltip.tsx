"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"

/**
 * The styled tooltip (v4 finesse pass): an ink chip — 12px, radius 7,
 * --e2, no arrow (nothing purely decorative) — matching the CSS .tipb
 * tooltip. Opens after a 300ms rest, so tooltips appear when you pause on
 * a control, never in passing; disableHoverableContent means the chip is
 * un-hoverable — the instant the cursor leaves the trigger it's gone.
 * Utilities, not v4 classes: the content portals outside any .v4 scope.
 */

/** The rest delay (ms): shared by hover and focus opens. */
export const TOOLTIP_DELAY_MS = 300

function TooltipProvider({
  delayDuration = TOOLTIP_DELAY_MS,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  disableHoverableContent = true,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return (
    <TooltipPrimitive.Root
      data-slot="tooltip"
      disableHoverableContent={disableHoverableContent}
      {...props}
    />
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn(
          "z-[70] flex w-fit max-w-72 origin-(--radix-tooltip-content-transform-origin) items-center gap-1.5 animate-in rounded-[7px] bg-foreground px-2 py-[5px] font-sans text-xs leading-4 font-medium text-primary-foreground text-balance shadow-e2 fade-in-0 zoom-in-[0.97] data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }