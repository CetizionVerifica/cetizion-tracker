import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"
import { Slot } from "radix-ui"

/*
 * Mocha Glass badges (design-system Badge). The four states — late, wait, ok,
 * info — carry a dot and their -soft ground; a state is always said in words
 * too. The shadcn variants map onto the system: destructive is late, secondary
 * the neutral track pill, default the coffee pill.
 */
const badgeVariants = cva(
  "mg-badge w-fit shrink-0 overflow-hidden transition-[color,box-shadow] focus-visible:outline-none focus-visible:ring-4 focus-visible:ring-wait-soft aria-invalid:ring-4 aria-invalid:ring-late-soft [&>svg]:pointer-events-none [&>svg]:size-3",
  {
    variants: {
      variant: {
        default: "mg-badge--plain bg-primary text-primary-foreground [a&]:hover:bg-primary/90",
        secondary: "mg-badge--plain [a&]:hover:bg-accent",
        destructive: "mg-badge--late",
        outline:
          "mg-badge--plain border border-border bg-transparent text-foreground [a&]:hover:bg-accent",
        ghost: "mg-badge--plain bg-transparent [a&]:hover:bg-accent",
        link: "mg-badge--plain bg-transparent text-caramel-text underline-offset-4 [a&]:hover:underline",
        late: "mg-badge--late",
        wait: "mg-badge--wait",
        warning: "mg-badge--wait",
        ok: "mg-badge--ok",
        success: "mg-badge--ok",
        info: "mg-badge--info",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Badge({
  className,
  variant = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"span"> &
  VariantProps<typeof badgeVariants> & { asChild?: boolean }) {
  const Comp = asChild ? Slot.Root : "span"

  return (
    <Comp
      data-slot="badge"
      data-variant={variant}
      className={cn(badgeVariants({ variant }), className)}
      {...props}
    />
  )
}

export { Badge, badgeVariants }
