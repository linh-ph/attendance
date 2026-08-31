"use client";

import { useCallback, useState } from "react";
import { GhostCanvas } from "./ghost-canvas";

/**
 * The waiting state: ghosts drifting past on their way to clock in.
 *
 * Two layers. The CSS scene is pure `transform`/`opacity` on a `perspective`
 * container, so it draws on the first frame with nothing to download. The
 * WebGL scene loads three.js in the background and takes over once it is
 * actually rendering, which is when the CSS one steps aside.
 *
 * The CSS layer is not only a stopgap: it is what anyone with reduced motion
 * keeps, and what a browser with no WebGL context falls back to. Both are
 * decorative and hidden from assistive technology — the live region below is
 * what announces the wait.
 */

interface Ghost {
  /** Depth in px. More negative sits further back: smaller, dimmer, slower. */
  depth: number;
  /** Vertical lane, as a share of the scene height. */
  top: string;
  durationSeconds: number;
  delaySeconds: number;
  opacity: number;
}

const GHOSTS: Ghost[] = [
  { depth: 40, top: "38%", durationSeconds: 7, delaySeconds: -1, opacity: 0.95 },
  { depth: -60, top: "14%", durationSeconds: 9, delaySeconds: -4, opacity: 0.7 },
  { depth: -140, top: "58%", durationSeconds: 11, delaySeconds: -7, opacity: 0.5 },
  { depth: -220, top: "30%", durationSeconds: 14, delaySeconds: -2, opacity: 0.34 },
];

export interface LoadingGhostsProps {
  /** Announced to assistive technology and shown under the scene. */
  label: string;
}

export function LoadingGhosts({ label }: LoadingGhostsProps) {
  const [webglDrawing, setWebglDrawing] = useState(false);

  /*
   * `GhostCanvas` lists this in its effect dependencies, so a fresh identity on
   * every render would tear down and rebuild the whole WebGL scene each time
   * the callback itself caused a render.
   */
  const handleReady = useCallback(() => setWebglDrawing(true), []);

  return (
    <div className="loading-ghosts">
      <GhostCanvas onReady={handleReady} />

      <div
        className={webglDrawing ? "ghost-scene ghost-scene-replaced" : "ghost-scene"}
        aria-hidden="true"
      >
        {GHOSTS.map((ghost, index) => (
          <div
            key={index}
            className="ghost-drift"
            style={
              {
                "--ghost-depth": `${ghost.depth}px`,
                "--ghost-duration": `${ghost.durationSeconds}s`,
                "--ghost-delay": `${ghost.delaySeconds}s`,
                "--ghost-opacity": ghost.opacity,
                top: ghost.top,
              } as React.CSSProperties
            }
          >
            <div className="ghost-bob">
              <div className="ghost-turn">
                <svg className="ghost" viewBox="0 0 88 96" role="presentation">
                  <path
                    className="ghost-body"
                    d="M44 6 C24 6 8 24 8 46 V86 l9 -8 l9 8 l9 -8 l9 8 l9 -8 l9 8 l9 -8 l9 8 V46 C80 24 64 6 44 6 Z"
                  />
                  <g className="ghost-eyes">
                    <ellipse cx="32" cy="42" rx="5" ry="6.5" />
                    <ellipse cx="56" cy="42" rx="5" ry="6.5" />
                  </g>
                </svg>
              </div>
            </div>
          </div>
        ))}
      </div>

      <p className="loading-ghosts-label" role="status">
        {label}
      </p>
    </div>
  );
}
