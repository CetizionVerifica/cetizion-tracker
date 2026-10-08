import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/*
 * Mocha Glass buttons (design-system Button): fully rounded pills built on the
 * system's own .mg-btn classes. Heights 36 (sm), 44 (default), 48 (lg). The
 * primary is the coffee fill and jellies on press; every other kind gets the
 * softer press (both wired in styles/mocha/motion.js). One primary per view.
 */
const buttonVariants = cva(
  "mg-btn shrink-0 outline-none disabled:pointer-events-none aria-invalid:border-destructive aria-invalid:ring-4 aria-invalid:ring-late-soft [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default: "mg-btn--primary",
        destructive: "mg-btn--danger",
        outline: "",
        secondary: "",
        ghost: "mg-btn--ghost",
        link: "mg-btn--ghost !h-auto !px-0 text-caramel-text underline-offset-4 hover:!bg-transparent hover:underline",
      },
      size: {
        default: "",
        xs: "mg-btn--sm gap-1 px-2.5 text-xs [&_svg:not([class*='size-'])]:size-3.5",
        sm: "mg-btn--sm gap-1.5",
        lg: "mg-btn--lg",
        icon: "mg-btn--icon",
        "icon-xs": "mg-btn--sm mg-btn--icon [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "mg-btn--sm mg-btn--icon",
        "icon-lg": "mg-btn--lg mg-btn--icon",
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
