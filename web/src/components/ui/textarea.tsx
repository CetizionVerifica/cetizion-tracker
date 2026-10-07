import * as React from "react"
import { cn } from "cn"

function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-20 w-full rounded-[14px] border border-input bg-glass-strong px-3.5 py-2.5 text-base transition-[color,box-shadow,border-color] outline-none hover:border-glass-edge placeholder:text-muted-foreground focus-visible:border-caramel focus-visible:ring-4 focus-visible:ring-wait-soft focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-4 aria-invalid:ring-late-soft md:text-[13.5px]",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
