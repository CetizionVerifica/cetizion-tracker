import { useId } from 'react';

/**
 * One panel of an account pane (Wave 8): strong glass, an h2 title and the
 * sentence saying what it is for, then its content. The pane's own name is
 * the page's h1, so a single-panel pane leaves `title` out.
 */
export function Pane({ title, description, actions, children }) {
  const id = useId();
  return (
    <section className="mg-glass mg-glass--strong mg-panel @container" data-a="rise" aria-labelledby={title ? id : undefined}>
      {(title || actions) && (
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-[1_1_240px] flex-col gap-0.5">
            {title && <h2 className="mg-panel__title" id={id}>{title}</h2>}
            {description && <span className="mg-panel__hint">{description}</span>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
}
