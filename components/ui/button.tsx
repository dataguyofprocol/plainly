import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

/* The shared Button, on the v4 tokens (finesse pass): the same geometry
   and weights as .btn/.ghost in app/v4.css, as utilities so it renders the
   same inside or outside a .v4 scope. Variant names and sizes are the API. */
const buttonVariants = cva(
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 rounded-[9px] text-[13px] leading-none font-semibold whitespace-nowrap transition-[background-color,box-shadow,color,transform] duration-150 outline-none active:scale-[0.97] focus-visible:ring-[3px] focus-visible:ring-ring/25 disabled:pointer-events-none disabled:opacity-40 aria-invalid:shadow-[inset_0_0_0_1px_var(--danger)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground shadow-[inset_0_1px_0_rgb(255_255_255/0.1),0_1px_2px_rgb(from_var(--shadow-ink)_r_g_b/0.16)] hover:bg-primary/90",
        destructive: "bg-danger text-primary-foreground hover:bg-danger/90 focus-visible:ring-danger/20",
        outline: "bg-surface text-foreground shadow-[inset_0_0_0_1px_var(--line-strong)] hover:bg-accent hover:text-accent-foreground",
        secondary: "bg-secondary text-secondary-foreground hover:bg-secondary/80",
        ghost: "hover:bg-accent hover:text-accent-foreground",
        link: "text-brand underline-offset-4 hover:underline",
      },
      size: {
        default: "h-[34px] px-3.5 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-[7px] px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-7 gap-1.5 rounded-lg px-2.5 text-xs has-[>svg]:px-2 [&_svg:not([class*='size-'])]:size-3.5",
        lg: "h-10 gap-2 rounded-xl px-[18px] text-sm has-[>svg]:px-4",
        icon: "size-[34px]",
        "icon-xs": "size-6 rounded-[7px] [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-7 rounded-lg",
        "icon-lg": "size-10 rounded-xl",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
