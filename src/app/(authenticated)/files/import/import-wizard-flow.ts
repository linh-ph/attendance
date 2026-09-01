import type { WizardStep } from "@/components/wizard-shell";

export type ImportFlowStep = "upload" | "preflight" | "details" | "review";

export const IMPORT_STEPS: readonly WizardStep[] = [
  { id: "upload", label: "Upload", description: "Choose an XLSX workbook" },
  { id: "preflight", label: "Preflight", description: "Inspect sheets and dates" },
  { id: "details", label: "Details", description: "Output and sheet owners" },
  { id: "review", label: "Review", description: "Confirm before Drive changes" },
  { id: "setup", label: "Setup", description: "Convert, share, and recover" },
];

export const IMPORT_STEP_COPY: Record<ImportFlowStep, { title: string; lede: string }> = {
  upload: {
    title: "Upload workbook",
    lede: "Choose the workbook to inspect. This step does not change Google Drive.",
  },
  preflight: {
    title: "Workbook preflight",
    lede: "Confirm every recognized sheet and its detected attendance month before continuing.",
  },
  details: {
    title: "Output details and sheet owners",
    lede: "Set the output, destination, and one Google Workspace owner for every sheet.",
  },
  review: {
    title: "Review and import",
    lede: "Check the complete import plan before Google Drive is changed.",
  },
};
