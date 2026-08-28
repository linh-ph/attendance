/**
 * Retryable attendance file setup.
 *
 * The service composes the Drive/Sheets gateways and the sheet-native config
 * repository into two flows over one shared tail:
 *
 * - `create` builds (or resumes) a monthly file this application owns from the
 *   first cell up — see `setup-monthly.ts` for the ordered steps of section
 *   8.1 of the approved design;
 * - `inspectExisting` and `configureExisting` adopt a file created outside this
 *   application, reading and protecting its tabs but never templating them —
 *   see `setup-legacy.ts`.
 *
 * Both end in `finishSetup` from `setup-steps.ts`, so protections, invitations,
 * and the `ready` transition are recorded in exactly one place. A created file
 * is never deleted as rollback (section 9.2): a failed attempt returns the file
 * ID, the revalidated folder, and per-member progress so the browser can resume.
 *
 * The error types and the shapes both Route Handlers depend on live in
 * `setup-contracts.ts` and are re-exported here, so this module stays the one
 * import site for everything about setup.
 */

import type { SetupService, SetupServiceDependencies } from "./setup-contracts";
import { createLegacySetup } from "./setup-legacy";
import { createMonthlySetup } from "./setup-monthly";
import { createSetupSteps } from "./setup-steps";

export {
  LegacySetupError,
  MEMBER_INVITE_FAILED_MESSAGE,
  MEMBER_SETUP_STATUSES,
  SetupError,
  isLegacySetupError,
  isSetupError,
  type ConfigureExistingFileInput,
  type CreateMonthlyFileInput,
  type ExistingFileInspection,
  type ExistingSheet,
  type ExistingSheetMapping,
  type InspectExistingFileInput,
  type LegacySetupErrorCode,
  type MemberSetupProgress,
  type MemberSetupStatus,
  type MonthlySetupResult,
  type SetupErrorCode,
  type SetupService,
  type SetupServiceDependencies,
} from "./setup-contracts";

export function createSetupService(dependencies: SetupServiceDependencies): SetupService {
  const steps = createSetupSteps(dependencies);
  const monthly = createMonthlySetup(dependencies, steps);
  const legacy = createLegacySetup(dependencies, steps);

  return {
    create: monthly.create,
    inspectExisting: legacy.inspectExisting,
    configureExisting: legacy.configureExisting,
  };
}
