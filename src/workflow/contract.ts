/**
 * Context Contract types (Session 1 of the context-contract redesign).
 *
 * These mirror the JSON schema from specs/context-contract.md §1 (two-file
 * representation) and §2 (typed context entries). A project workflow is
 * stored at `.claude/ewh-workflows/<name>.json` conforming to
 * `WorkflowContract`; the companion `workflow.md` summary is derived from it.
 *
 * Nothing in this module resolves refs to disk — that's Session 6 (doctor).
 */

export type ContextEntry =
  | { type: 'rule'; ref: string }
  | { type: 'artifact'; ref: string }
  | { type: 'file'; ref: string };

export type ContractStep = {
  name: string;
  agent: string;
  description: string;
  gate: 'structural' | 'auto';
  produces: string[];
  context: ContextEntry[];
  requires: Array<{ file_exists: string } | { prior_step: string; has: string }>;
  chunked: boolean;
  script: string | null;
  script_fallback: 'gate' | 'auto';
};

export type WorkflowContract = {
  name: string;
  description: string;
  steps: ContractStep[];
};
