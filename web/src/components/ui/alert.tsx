import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "cn"

const alertVariants = cva(
  "relative grid w-full grid-cols-[0_1fr] items-start gap-y-0.5 rounded-[18px] border-0 px-4 py-3.5 text-[13.5px] text-foreground has-[>svg]:grid-cols-[18px_1fr] has-[>svg]:gap-x-3 [&>svg]:size-[18px] [&>svg]:translate-y-px",
  {
    variants: {
      variant: {
        default: "bg-info-soft [&>svg]:text-info",
        info: "bg-info-soft [&>svg]:text-info",
        destructive: "bg-late-soft [&>svg]:text-late",
        late: "bg-late-soft [&>svg]:text-late",
        warning: "bg-wait-soft [&>svg]:text-wait",
        wait: "bg-wait-soft [&>svg]:text-wait",
        success: "bg-ok-soft [&>svg]:text-ok",
        ok: "bg-ok-soft [&>svg]:text-ok",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

function Alert({
  className,
  variant,
  ...props
}: React.ComponentProps<"div"> & VariantProps<typeof alertVariants>) {
  return (
    <div
      data-slot="alert"
      role="alert"
      className={cn(alertVariants({ variant }), className)}
      {...props}
    />
  )
}

function AlertTitle({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-title"
      className={cn(
        "col-start-2 line-clamp-1 min-h-4 font-bold",
        className
      )}
      {...props}
    />
  )
}

function AlertDescription({
  className,
  ...props
}: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="alert-description"
      className={cn(
        "col-start-2 grid justify-items-start gap-1 text-[13.5px] text-secondary-text [&_p]:leading-relaxed",
        className
      )}
      {...props}
    />
  )
}

export { Alert, AlertTitle, AlertDescription }
