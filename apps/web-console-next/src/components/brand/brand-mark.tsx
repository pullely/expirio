import * as React from "react";
import { cn } from "@/lib/cn";

/**
 * The Expirio mark: an hourglass.
 *
 * Drawn on a 24×24 grid in `currentColor`, so it takes the colour of the
 * badge it sits in (`text-primary-foreground` on `bg-primary`).
 * `src/app/icon.svg` is the same mark with fixed colours, because a favicon
 * can't read CSS variables.
 */
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      className={cn("h-5 w-5", className)}
      aria-hidden="true"
      focusable="false"
    >
      <path d="M6 3h12M6 21h12" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M7.5 3.5c0 4 4.5 5.5 4.5 8.5s-4.5 4.5-4.5 8.5M16.5 3.5c0 4-4.5 5.5-4.5 8.5s4.5 4.5 4.5 8.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      <path d="M9 20.5c.5-2 2-3 3-3s2.5 1 3 3z" fill="currentColor" />
    </svg>
  );
}
