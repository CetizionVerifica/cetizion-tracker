import * as React from "react"
import { cn } from "cn"
import { Progress as ProgressPrimitive } from "radix-ui"

/*
 * Mocha Glass progress (design-system StatTile/Hero bars): a 10px pill on
 * `track`, the done part in `figure`. `expected` (optional, a percentage)
 * adds the hatched caramel segment after it: money expected, not yet in.
 */
function Progress({
  className,
  value,
  expected,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root> & { expected?: number }) {
  const done = Math.max(0, Math.min(100, value || 0))
  const ahead = Math.max(0, Math.min(100 - done, expected || 0))
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        "relative h-2.5 w-full overflow-hidden rounded-full bg-track",
        className
      )}
      value={value}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full w-full flex-1 rounded-full bg-figure transition-transform duration-700 ease-[cubic-bezier(.22,1,.36,1)] motion-reduce:transition-none"
        style={{ transform: `translateX(-${100 - done}%)` }}
      />
      {ahead > 0 && (
        <span
          data-slot="progress-expected"
          aria-hidden="true"
          className="mg-hatch absolute inset-y-0"
          style={{ left: `${done}%`, width: `${ahead}%` }}
        />
      )}
    </ProgressPrimitive.Root>
  )
}

export { Progress }
