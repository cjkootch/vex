import Link from "next/link";
import type { ReactNode } from "react";

/**
 * Premium page header. Locks in a consistent rhythm across every
 * detail page in the product:
 *
 *   eyebrow   · tiny uppercase nav/context label
 *   title     · large tracked-tight display headline
 *   meta      · small secondary line (product, buyer, timestamp)
 *   pills     · status / readiness / flag chips
 *   actions   · primary + secondary buttons, right-aligned
 *
 * Layout is intentionally light — no background surface, no heavy
 * border — so the header reads as a command-center label rather
 * than another card. The thin 1px hairline underneath anchors it
 * to the page without adding a frame.
 */
export interface PageHeaderProps {
  eyebrow?: ReactNode;
  /** Main title — rendered as a display/title token. */
  title: ReactNode;
  /** Optional monospaced subtitle, e.g. a deal ref. */
  titleRef?: ReactNode;
  /** Secondary descriptor: product · volume · buyer · etc. */
  meta?: ReactNode;
  /** Status + readiness + compliance pills. */
  pills?: ReactNode;
  /** Right-aligned action buttons. */
  actions?: ReactNode;
  /** Optional back-link (renders as the eyebrow when supplied). */
  backHref?: string;
  backLabel?: string;
}

export function PageHeader({
  eyebrow,
  title,
  titleRef,
  meta,
  pills,
  actions,
  backHref,
  backLabel,
}: PageHeaderProps): React.ReactElement {
  const eyebrowNode = backHref ? (
    <Link
      href={backHref}
      className="group inline-flex items-center gap-1 text-eyebrow text-text-muted transition-colors hover:text-text-secondary"
    >
      <span aria-hidden="true" className="transition-transform group-hover:-translate-x-0.5">
        ←
      </span>
      {backLabel ?? "Back"}
    </Link>
  ) : (
    eyebrow && <div className="text-eyebrow text-text-muted">{eyebrow}</div>
  );

  return (
    <header className="flex flex-col gap-4 border-b border-line-soft pb-5">
      {eyebrowNode}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-3">
            {titleRef && (
              <span className="num-mono text-title text-text-primary">
                {titleRef}
              </span>
            )}
            <h1 className="text-title text-text-primary">{title}</h1>
            {pills && (
              <div className="flex flex-wrap items-center gap-2">{pills}</div>
            )}
          </div>
          {meta && (
            <p className="mt-1.5 text-sm text-text-secondary">{meta}</p>
          )}
        </div>
        {actions && (
          <div className="flex flex-shrink-0 items-center gap-2">
            {actions}
          </div>
        )}
      </div>
    </header>
  );
}

/**
 * Standardized section header. Use in long pages to break content
 * into operator-scanable bands. The count + trailing action render
 * on the same baseline as the title for a settled feel.
 */
export function SectionHeader({
  eyebrow,
  title,
  count,
  trailing,
}: {
  eyebrow?: string;
  title: ReactNode;
  count?: number;
  trailing?: ReactNode;
}): React.ReactElement {
  return (
    <header className="mb-3 flex items-end justify-between gap-3">
      <div className="flex items-baseline gap-2">
        {eyebrow && (
          <span className="text-eyebrow text-text-muted">{eyebrow}</span>
        )}
        <h2 className="text-h2 text-text-primary">{title}</h2>
        {typeof count === "number" && (
          <span className="num text-xs text-text-muted">· {count}</span>
        )}
      </div>
      {trailing && <div>{trailing}</div>}
    </header>
  );
}
