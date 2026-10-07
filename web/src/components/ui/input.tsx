import * as React from "react"
import { cn } from "cn"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-11 w-full min-w-0 rounded-[14px] border border-input bg-glass-strong px-3.5 py-1 text-base transition-[color,box-shadow,border-color] outline-none hover:border-glass-edge selection:bg-caramel selection:text-on-caramel [&[type=date]]:pr-10 [&[type=month]]:pr-10 [&[type=time]]:pr-10 [&[type=datetime-local]]:pr-10 [&[list]]:pr-10 file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-[13.5px]",
        "focus-visible:border-caramel focus-visible:ring-4 focus-visible:ring-wait-soft focus-visible:outline-none",
        "aria-invalid:border-destructive aria-invalid:ring-4 aria-invalid:ring-late-soft",
        className
      )}
      {...props}
    />
  )
}

export { Input }
