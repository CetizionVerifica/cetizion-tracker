import { cn } from "cn"

/* Mocha Glass loading bars (design-system States): `track` with a sheen that
   sweeps across; the pause button and reduced motion hold it still. */
function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("mg-skel", className)}
      {...props}
    />
  )
}

export { Skeleton }
