import { Card, CardContent } from '../../components/ui/card.tsx';

/**
 * The shape every account pane wears: a title, one sentence saying what
 * the pane is for, and the room around it.
 *
 * Its own component for the same reason SettingsPane is: four panes that
 * each invent their own heading and padding look like four screens rather
 * than one.
 */
export function Pane({ title, description, actions, children }) {
  return (
    /* A container, not a viewport query: the pane sits beside a rail and is
       far narrower than the window, so a grid switching on window width
       would go two-column while it had 600px to do it in. */
    <Card className="@container gap-0 rounded-lg border-border py-0 shadow-none">
      <CardContent className="px-5 py-5 sm:px-6 sm:py-6">
        <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-semibold text-foreground">{title}</h2>
            {description && (
              <p className="mt-1 max-w-[62ch] text-[12.5px]/[1.6] text-secondary-text">{description}</p>
            )}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
        {children}
      </CardContent>
    </Card>
  );
}
