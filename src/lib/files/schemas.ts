import { z } from "zod";
import { ATTENDANCE_NAME_MARKER } from "@/lib/google/types";

/**
 * Boundary validation for the monthly create request.
 *
 * The output name must contain the same marker Drive discovery queries filter
 * on, so a file this schema accepts is always findable again. The month is
 * `YYYY-MM`, emails are normalized to lowercase, and at least one valid member
 * is required before any Google mutation is attempted.
 */
export const createFileInputSchema = z.object({
  fileName: z
    .string()
    .trim()
    .min(1)
    .refine((name) => name.includes(ATTENDANCE_NAME_MARKER)),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  destinationFolder: z.object({ id: z.string().min(1), name: z.string().min(1) }),
  members: z
    .array(
      z.object({
        displayName: z.string().trim().min(1),
        email: z.email().transform((value) => value.toLowerCase()),
      }),
    )
    .min(1),
  /*
   * Whether Drive emails each member that the file has been shared with them.
   * The sharing itself happens either way — the file lands in their Drive
   * regardless — so this decides only whether the message goes out. It defaults
   * to true, which is what creating a file did before this existed.
   */
  sendInvitations: z.boolean().default(true),
});

export type CreateFileInput = z.infer<typeof createFileInputSchema>;
export type CreateFileMemberInput = CreateFileInput["members"][number];
