/**
 * Early-exit policy (Issue #12 section 16). A clean review may skip
 * Sparring and go straight to a minimal Leo verdict only when every
 * required condition holds — never merely because a file "looks like"
 * docs, config, UI, or because April saw no obvious logic change.
 */

export interface EarlyExitInputs {
  caseFileComplete: boolean;
  /** True only if every specialist required by policy actually returned a result (a missing/failed lane blocks early exit). */
  allRequiredLanesCleanAndComplete: boolean;
  /** April recorded no unresolved UNKNOWN that could matter to the verdict. */
  noUnresolvedContext: boolean;
  /** No specialist raised anything material enough to be a candidate finding. */
  noMaterialObservations: boolean;
  /** Splinter found no recurring-pattern or guardrail trigger. */
  noGuardrailOrHistoryTrigger: boolean;
}

export function canEarlyExit(inputs: EarlyExitInputs): boolean {
  return (
    inputs.caseFileComplete &&
    inputs.allRequiredLanesCleanAndComplete &&
    inputs.noUnresolvedContext &&
    inputs.noMaterialObservations &&
    inputs.noGuardrailOrHistoryTrigger
  );
}
