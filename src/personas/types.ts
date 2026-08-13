/**
 * A persona is data, not code: character, temperament, review instinct, and
 * hard rules all live in config/personas/*.yaml. This type describes only
 * the fields the runtime actually reads — everything else in the YAML
 * (dialogue anchors, relationships, persona_anchor, ...) is preserved and
 * passed through for prompting, but is not structurally required here.
 */
export interface PersonaConfig {
  name: string;
  codename: string;
  role: string;
  team?: string;
  group?: string;
  purpose?: string;
  temperament: Record<string, string>;
  allowed_outcomes: Record<string, string>;
  hard_rules: string[];
  persona_anchor: string;
  authority_boundary: AuthorityBoundary;
  primary_lane?: string[];
  secondary_lane?: string[];
  /** Everything else in the file — passed through untouched for prompting. */
  [key: string]: unknown;
}

/**
 * A persona can never do these things directly. The orchestrator does not
 * trust this block on its own — it is enforced in code — but the validator
 * rejects any persona file that claims otherwise, so a bad edit fails fast
 * instead of silently drifting from the authority model.
 */
export interface AuthorityBoundary {
  can_mutate_github: boolean;
  can_submit_pr_review_state: boolean;
  can_resolve_review_threads: boolean;
  can_call_arbitrary_tools: boolean;
  can_execute_repository_code: boolean;
  can_override_orchestrator: boolean;
  /** Only Shredder's file sets this; absence means "no" by default. */
  has_veto?: boolean;
}

export const KNOWN_ROLES = [
  'final_arbiter',
  'runtime_hunter',
  'systems_architect',
  'human_experience_chaos_tester',
  'engineering_discipline_mentor',
  'investigative_context_analyst',
  'operational_abuse_tester',
  'adversarial_challenger',
] as const;

export type PersonaRole = (typeof KNOWN_ROLES)[number];
