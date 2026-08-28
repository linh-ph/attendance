"use client";

import { useState } from "react";
import {
  loadPicker,
  openPicker,
  readPickerCredentials,
  type PickedItem,
  type PickerMode,
} from "@/lib/google/picker";

interface GooglePickerProps {
  mode: PickerMode;
  label: string;
  onSelect: (item: PickedItem) => void;
  disabled?: boolean;
}

async function requestPickerToken(): Promise<string> {
  const response = await fetch("/api/google/picker-token", {
    method: "GET",
    cache: "no-store",
    credentials: "same-origin",
  });

  if (!response.ok) {
    throw new Error(
      response.status === 401
        ? "Your Google session expired. Sign in again to continue."
        : "Could not start Google Picker.",
    );
  }

  const body: unknown = await response.json();
  const accessToken = (body as { accessToken?: unknown })?.accessToken;

  if (typeof accessToken !== "string" || !accessToken) {
    throw new Error("Could not start Google Picker.");
  }

  return accessToken;
}

/**
 * Opens Google Picker on demand. The short-lived access token is fetched at
 * open time, held only in this function's memory, and handed straight to
 * Picker; it is never stored in component state, props, or browser storage.
 */
export function GooglePicker({ mode, label, onSelect, disabled }: GooglePickerProps) {
  const [isOpening, setIsOpening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function open() {
    setIsOpening(true);
    setError(null);

    try {
      const { developerKey, appId } = readPickerCredentials();
      const accessToken = await requestPickerToken();
      const picker = await loadPicker();

      openPicker(picker, {
        mode,
        accessToken,
        developerKey,
        appId,
        origin: window.location.origin,
        onPicked: onSelect,
      });
    } catch (openError) {
      setError(
        openError instanceof Error ? openError.message : "Could not start Google Picker.",
      );
    } finally {
      setIsOpening(false);
    }
  }

  return (
    <div className="google-picker">
      <button type="button" onClick={open} disabled={disabled || isOpening}>
        {isOpening ? "Opening Google Picker…" : label}
      </button>
      {error ? (
        <p role="alert" className="google-picker-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
