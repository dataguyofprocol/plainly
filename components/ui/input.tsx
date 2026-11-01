import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-10 w-full min-w-0 rounded-[10px] border-0 bg-surface px-3 text-sm text-foreground shadow-[inset_0_0_0_1px_var(--line-strong)] transition-shadow duration-200 outline-none selection:bg-brand-soft file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-faint hover:shadow-[inset_0_0_0_1px_var(--line-hover)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40",
        "focus-visible:shadow-[inset_0_0_0_1px_var(--brand),var(--focus-ring)]",
        "aria-invalid:shadow-[inset_0_0_0_1px_var(--danger)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
