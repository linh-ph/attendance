export type PickerMode = "folder" | "spreadsheet";

export interface PickedItem {
  id: string;
  name: string;
}

export interface PickerCredentials {
  /** Referrer-restricted browser API key. */
  developerKey: string;
  /** Cloud project number used as the Picker app id. */
  appId: string;
}

export interface OpenPickerInput extends PickerCredentials {
  mode: PickerMode;
  accessToken: string;
  origin: string;
  onPicked: (item: PickedItem) => void;
  onCancel?: () => void;
}

const PICKER_API_URL = "https://apis.google.com/js/api.js";
const PICKER_SCRIPT_ID = "google-picker-api";

/* -------------------------------------------------------------------------- */
/* Minimal structural typing for the global Picker namespace                   */
/* -------------------------------------------------------------------------- */

interface PickerDocsView {
  setIncludeFolders(value: boolean): PickerDocsView;
  setSelectFolderEnabled(value: boolean): PickerDocsView;
  setMimeTypes(value: string): PickerDocsView;
}

interface PickerBuilder {
  addView(view: PickerDocsView): PickerBuilder;
  setOAuthToken(token: string): PickerBuilder;
  setDeveloperKey(key: string): PickerBuilder;
  setAppId(appId: string): PickerBuilder;
  setOrigin(origin: string): PickerBuilder;
  setLocale(locale: string): PickerBuilder;
  disableFeature(feature: string): PickerBuilder;
  setCallback(callback: (data: PickerCallbackData) => void): PickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

export interface PickerCallbackData {
  action?: string;
  docs?: { id?: string; name?: string }[];
}

export interface PickerNamespace {
  DocsView: new () => PickerDocsView;
  PickerBuilder: new () => PickerBuilder;
  Action: { PICKED: string; CANCEL: string };
  Feature: { MULTISELECT_ENABLED: string };
}

interface GapiLoader {
  load(name: string, callback: () => void): void;
}

interface PickerWindow {
  gapi?: GapiLoader;
  google?: { picker?: PickerNamespace };
}

function pickerWindow(): PickerWindow {
  return window as unknown as PickerWindow;
}

export function readPickerCredentials(): PickerCredentials {
  const developerKey = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY ?? "";
  const appId = process.env.NEXT_PUBLIC_GOOGLE_CLOUD_PROJECT_NUMBER ?? "";

  if (!developerKey || !appId) {
    throw new Error("Google Picker is not configured.");
  }

  return { developerKey, appId };
}

function loadScript(): Promise<void> {
  return new Promise((resolve, reject) => {
    const existing = document.getElementById(PICKER_SCRIPT_ID);
    if (existing) {
      existing.addEventListener("load", () => resolve(), { once: true });
      if (pickerWindow().gapi) resolve();
      return;
    }

    const script = document.createElement("script");
    script.id = PICKER_SCRIPT_ID;
    script.src = PICKER_API_URL;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error("Could not load Google Picker."));
    document.head.append(script);
  });
}

/** Loads `api.js` once, then the Picker module, and returns the namespace. */
export async function loadPicker(): Promise<PickerNamespace> {
  const loaded = pickerWindow().google?.picker;
  if (loaded) {
    return loaded;
  }

  await loadScript();

  const gapi = pickerWindow().gapi;
  if (!gapi) {
    throw new Error("Could not load Google Picker.");
  }

  await new Promise<void>((resolve) => gapi.load("picker", resolve));

  const namespace = pickerWindow().google?.picker;
  if (!namespace) {
    throw new Error("Could not load Google Picker.");
  }

  return namespace;
}

export function openPicker(picker: PickerNamespace, input: OpenPickerInput): void {
  const { mode } = input;

  const view = new picker.DocsView()
    .setIncludeFolders(mode === "folder")
    .setSelectFolderEnabled(mode === "folder")
    .setMimeTypes(
      mode === "folder"
        ? "application/vnd.google-apps.folder"
        : "application/vnd.google-apps.spreadsheet",
    );

  new picker.PickerBuilder()
    .addView(view)
    .setOAuthToken(input.accessToken)
    .setDeveloperKey(input.developerKey)
    .setAppId(input.appId)
    .setOrigin(input.origin)
    .setLocale("en")
    .disableFeature(picker.Feature.MULTISELECT_ENABLED)
    .setCallback((data) => {
      if (data.action === picker.Action.CANCEL) {
        input.onCancel?.();
        return;
      }

      if (data.action !== picker.Action.PICKED) {
        return;
      }

      const [document] = data.docs ?? [];
      if (document?.id) {
        input.onPicked({ id: document.id, name: document.name ?? "" });
      }
    })
    .build()
    .setVisible(true);
}
