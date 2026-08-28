import { z } from "zod";
import { ATTENDANCE_NAME_MARKER } from "@/lib/google/types";
import { MAX_WORKBOOK_BYTES, WorkbookCheckError } from "@/lib/workbook/xlsx-inspector";

/**
 * Boundary validation for the `.xlsx` import requests.
 *
 * Both import routes read a multipart body, so the upload-size and form-field
 * rules live here next to the schema they feed. Nothing in this module talks to
 * Google; it only decides whether a request is worth acting on.
 *
 * The manager-confirmed output name is authoritative and must contain the same
 * marker Drive discovery filters on, so an imported file stays findable. The
 * month is never derived from the upload's file name — it is confirmed by the
 * manager and every recognized sheet is validated against it later.
 *
 * A mapping only *selects* a sheet by the title the workbook already carries;
 * the stored sheet title always comes from the inspected workbook, never from
 * this payload. `displayName` is optional because the import wizard collects
 * emails per detected sheet, not new tab names.
 */
export const importFileInputSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .refine((name) => name.includes(ATTENDANCE_NAME_MARKER)),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  destinationFolder: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  mappings: z
    .array(
      z.object({
        sheetTitle: z.string().min(1),
        displayName: z.string().trim().min(1).optional(),
        email: z.email().transform((value) => value.toLowerCase()),
      }),
    )
    .min(1),
});

export type ImportFileInput = z.infer<typeof importFileInputSchema>;
export type ImportSheetMappingInput = ImportFileInput["mappings"][number];

/** Resume hint for a converted file whose setup failed after Drive conversion. */
export const resumeFileIdSchema = z.string().trim().min(1);

/* -------------------------------------------------------------------------- */
/* Multipart upload boundary                                                   */
/* -------------------------------------------------------------------------- */

export const UPLOAD_FIELD = "file";
export const RESUME_FIELD = "resumeFileId";

const UPLOAD_TOO_LARGE_MESSAGE = "The workbook must be 20 MB or smaller.";
const MISSING_UPLOAD_MESSAGE = "Attach an .xlsx workbook to import.";
const MALFORMED_UPLOAD_MESSAGE = "Send the workbook as a multipart form upload.";

/** Fields that are JSON documents rather than plain strings. */
const JSON_FIELDS = ["destinationFolder", "mappings"] as const;

/**
 * Rejects an upload the client already declared as oversize.
 *
 * The declared length covers the whole multipart envelope, so a body at the
 * limit is refused before it is buffered. Bodies that declare no length are
 * caught by `readWorkbookUpload` once they have been read.
 */
export function assertDeclaredSizeWithinLimit(request: Request): void {
  const declared = Number(request.headers.get("content-length"));
  if (!Number.isFinite(declared) || declared <= MAX_WORKBOOK_BYTES) return;

  throw new WorkbookCheckError("file-too-large", UPLOAD_TOO_LARGE_MESSAGE);
}

export async function readMultipartForm(request: Request): Promise<FormData> {
  try {
    return await request.formData();
  } catch {
    throw new WorkbookCheckError("unsupported-file", MALFORMED_UPLOAD_MESSAGE);
  }
}

/** Reads the uploaded bytes and enforces the limit again after buffering. */
export async function readWorkbookUpload(form: FormData): Promise<Uint8Array> {
  const upload = form.get(UPLOAD_FIELD);

  if (upload === null || typeof upload === "string") {
    throw new WorkbookCheckError("unsupported-file", MISSING_UPLOAD_MESSAGE);
  }

  const bytes = new Uint8Array(await upload.arrayBuffer());
  if (bytes.byteLength > MAX_WORKBOOK_BYTES) {
    throw new WorkbookCheckError("file-too-large", UPLOAD_TOO_LARGE_MESSAGE);
  }

  return bytes;
}

function readTextField(form: FormData, name: string): string | undefined {
  const value = form.get(name);
  return typeof value === "string" ? value : undefined;
}

function readJsonField(form: FormData, name: string): unknown {
  const raw = readTextField(form, name);
  if (raw === undefined) return undefined;

  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

/**
 * Parses the confirmed name, month, folder, and mappings out of the multipart
 * body. Returns `null` for anything the schema rejects so the route answers a
 * single safe validation error without leaking parser detail.
 */
export function parseImportFields(form: FormData): ImportFileInput | null {
  const candidate: Record<string, unknown> = {
    fileName: readTextField(form, "fileName"),
    month: readTextField(form, "month"),
  };

  for (const field of JSON_FIELDS) {
    candidate[field] = readJsonField(form, field);
  }

  const parsed = importFileInputSchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

export function readResumeFileId(form: FormData): string | undefined {
  const parsed = resumeFileIdSchema.safeParse(readTextField(form, RESUME_FIELD));
  return parsed.success ? parsed.data : undefined;
}
