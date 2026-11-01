import * as React from "react"

import { cn } from "@/lib/utils"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-[10px] border-0 bg-surface px-3 py-2.5 text-sm leading-5 text-foreground shadow-[inset_0_0_0_1px_var(--line-strong)] transition-shadow duration-200 outline-none placeholder:text-faint focus-visible:shadow-[inset_0_0_0_1px_var(--brand),var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-40 aria-invalid:shadow-[inset_0_0_0_1px_var(--danger)]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
