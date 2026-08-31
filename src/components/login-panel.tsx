import Image from "next/image";
import type { ReactNode } from "react";

/**
 * The unauthenticated entry point, shared by `/` and `/login` so the two cannot
 * drift apart.
 *
 * One DOM order serves both layouts. It is the mobile order the specification
 * asks for — brand, artwork, message, action, trust cue — and the desktop split
 * is produced by grid areas rather than by reordering or duplicating anything.
 * That matters twice over: a second `<img>` would mean two artworks to keep in
 * step, and a CSS-only reorder would leave the keyboard and screen-reader order
 * disagreeing with what is on screen.
 *
 * The artwork itself is fixed product content (spec §2.3): the same complete
 * image on both surfaces, at its own aspect ratio, never cropped to fill. Only
 * its frame — background, radius, shadow — belongs to this component.
 */

/** The intrinsic size of `public/meme.jpeg`. */
const ART_WIDTH = 387;
const ART_HEIGHT = 516;

const TRUST_CUES = [
  "Google Workspace",
  "Your Drive permissions",
  "No separate password",
] as const;

export interface LoginPanelProps {
  /** The single primary action. Supplied by the caller so this stays pure. */
  action: ReactNode;
}

export function LoginPanel({ action }: LoginPanelProps) {
  return (
    <section className="login" aria-labelledby="login-title">
      <p className="login-brand" data-login="brand">
        <span className="login-brand-mark" aria-hidden="true">
          BA
        </span>
        <span className="login-brand-name">blended-asia Attendance</span>
      </p>

      {/*
        Decorative: an empty alt keeps it out of the accessibility tree, so the
        page reads the same whether or not the image loads.
      */}
      <div className="login-art">
        <Image
          className="login-image"
          src="/meme.jpeg"
          alt=""
          width={ART_WIDTH}
          height={ART_HEIGHT}
          priority
        />
      </div>

      <div className="login-message">
        <span className="login-eyebrow">Your workday, in one place</span>
        <h1 id="login-title">Attendance that stays in sync.</h1>
        <p className="login-lede">
          Record working hours, review your month, and keep the team spreadsheet
          up to date — without working directly in cells.
        </p>
      </div>

      <div className="login-action" data-login="action">
        {action}
      </div>

      <ul className="login-trust" data-login="trust">
        {TRUST_CUES.map((cue) => (
          <li key={cue}>
            <span className="login-trust-check" aria-hidden="true">
              ✓
            </span>
            {cue}
          </li>
        ))}
      </ul>

      <p className="login-privacy">
        By continuing, you sign in with your blended-asia Google Workspace
        account. The application only ever acts with your own Drive permissions.
      </p>
    </section>
  );
}
