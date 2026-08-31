"use client";

import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";

/**
 * Moves keyboard focus to the content region after a client-side navigation.
 *
 * A route change in the App Router swaps the page under the user without
 * touching focus, so a keyboard or screen-reader user who activates a
 * navigation link is left focused on a link that now points at the page they
 * are already on, with the new heading somewhere behind them. Focusing the
 * content region puts them at the top of the new page, which is where a full
 * page load would have left them.
 *
 * It deliberately does nothing on the first render — the initial load already
 * starts at the top of the document, and stealing focus there would fight the
 * browser's own restoration.
 *
 * Renders nothing.
 */
export function FocusOnRouteChange({ targetId }: Readonly<{ targetId: string }>) {
  const pathname = usePathname();
  const previous = useRef<string | null>(null);

  useEffect(() => {
    if (previous.current === pathname) {
      return;
    }

    const isFirstRender = previous.current === null;
    previous.current = pathname;

    if (isFirstRender) {
      return;
    }

    document.getElementById(targetId)?.focus();
  }, [pathname, targetId]);

  return null;
}
