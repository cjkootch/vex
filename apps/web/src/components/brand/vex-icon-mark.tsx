import type { ImgHTMLAttributes } from "react";

/**
 * Square Vex icon mark — the new (May 2026) brand emblem from
 * `public/icon-white.svg`. Renders via `<img>` so we ship the asset
 * once and skip the inline-SVG complexity (the new design uses
 * 95 paths with nested clipPaths — not JSX-friendly).
 *
 * The white-fill variant works well over the accent-coloured surface
 * the floating Ask-Vex widget paints (see `floating-vex-widget.tsx`).
 * For light-bg surfaces, point at `/icon-black.svg` instead via the
 * standard `<img>` `src` override. The previous component's
 * `ringFill` / `glyphFill` / `ring` props were retired — only one
 * call site uses this and didn't override any of them.
 */
export function VexIconMark({
  className,
  title = "Vex",
  alt,
  src = "/icon-white.svg",
  ...rest
}: ImgHTMLAttributes<HTMLImageElement> & { title?: string }) {
  // Vector SVG; next/image's optimization pipeline doesn't help
  // for a static, single-fill brand asset.
  return (
    /* eslint-disable-next-line @next/next/no-img-element */
    <img
      {...rest}
      src={src}
      alt={alt ?? title}
      className={className}
      role="img"
      aria-label={title}
    />
  );
}

