/**
 * Core state types for the EWH dispatcher binary (v2).
 *
 * StepState is a discriminated union keyed by `phase`. Each step of a
 * workflow advances through phases via pure transitions in `machine.ts`.
 *
 * Phase 1 only exercises `pending → complete` for trivial (no-op) steps;
 * richer phases are declared here so later phases can implement them
 * against a fixed shape and TypeScript's exhaustiveness checker.
 */

export type StepSummary = {
  step_name: string;
  outcome: 'completed' | 'skipped' | 'failed';
  files_modified?: string[];
  notes?: string;
  result_path?: string;
};

export type ContextRef = {
  step: string;
  detail: 'raw' | 'full' | 'summary';
};

export type Rule = {
  name: string;
  path: string;
  severity: 'critical' | 'warning' | 'info';
  verify?: string;
};

export type SplitChunk = {
  index: number;
  items: string[];
  result_path: string;
  /** Prompt file written for this chunk (used in split phase dispatch). */
  prompt_path: string;
};

export type StepState =
  | { phase: 'pending' }
  | { phase: 'precondition_failed'; reason: string }
  | { phase: 'gate_pending'; prompt: string }
  | { phase: 'script_eval' }
  | { phase: 'script_propose'; script: string; rationale: string; proposed_path: string }
  | { phase: 'script_run'; script_path: string; attempts: number }
  | { phase: 'chunk_plan' }
  | {
      phase: 'chunk_running';
      /** Per-chunk file lists. */
      chunks: string[][];
      /** Current chunk being dispatched. */
      chunk_index: number;
      total: number;
      completed: boolean[];
      /** Per-chunk prompt paths written to disk. */
      chunk_prompt_paths: string[];
      /** Per-chunk result paths (agent output target). */
      chunk_result_paths: string[];
      /**
       * Per-chunk artifact paths — each worker writes its findings here.
       * Merged into `step.artifact` during the chunk_merge phase.
       */
      chunk_artifact_paths: string[];
      /** Retries per chunk (mirrors agent_run retries). */
      retries: number[];
      /** Critical rules (cached from first prompt build) for the merged compliance check. */
      rules: Rule[];
      /** Whether the agent is incremental (list-producer with pre-created artifact). */
      incremental: boolean;
    }
  | {
      phase: 'chunk_merge';
      chunk_artifact_paths: string[];
      rules: Rule[];
      incremental: boolean;
    }
  | {
      phase: 'agent_run';
      prompt_path: string;
      result_path: string;
      retries: number;
      /** Critical rules (with verify commands) stored for compliance check. */
      rules: Rule[];
    }
  | {
      phase: 'continuation';
      /** Result file from the partial agent_run. */
      partial_path: string;
      /** Original agent prompt — needed to build split chunk prompts. */
      original_prompt_path: string;
      /** Prompt file written for the continuation agent. */
      continuation_prompt_path: string;
      /** Target result file for the continuation agent. */
      continuation_result_path: string;
      /** Critical rules carried forward to compliance after success. */
      rules: Rule[];
    }
  | {
      phase: 'split';
      chunks: SplitChunk[];
      completed: boolean[];
      /** Index of the chunk currently being dispatched. */
      current_chunk_index: number;
      rules: Rule[];
    }
  | {
      phase: 'split_merge';
      /** Chunks whose result files are concatenated into step.artifact. */
      chunks: SplitChunk[];
      rules: Rule[];
    }
  | {
      phase: 'artifact_verify';
      pending_summary: StepSummary;
      pending_rules: Rule[];
    }
  | { phase: 'compliance'; critical_rules: Rule[]; summary: StepSummary }
  | { phase: 'complete'; summary: StepSummary }
  | { phase: 'skipped'; reason: string };

export type StepPhase = StepState['phase'];

/**
 * A single step entry as parsed from a workflow file, plus its live state.
 * Phase 1 only populates the minimum fields; richer fields (rules, reads,
 * artifact, requires, context, chunked, script) land in later phases.
 */
export type Step = {
  name: string;
  agent?: string;
  gate: 'auto' | 'structural';
  description?: string;
  message?: string;
  // Phase 2 fields:
  rules?: string[];
  reads?: string[];
  artifact?: string;
  context?: ContextRef[];
  // Parsed and stored; acted on in Phase 3+ (preconditions), Phase 4 (scripts), Phase 5 (chunked):
  requires?: unknown;
  chunked?: boolean;
  script?: string;
  script_fallback?: 'gate' | 'auto';
  state: StepState;
};

export type WorkflowDef = {
  name: string;
  description?: string;
  trigger?: string;
  steps: Step[];
};

export type RunState = {
  run_id: string;
  workflow: string;
  raw_argv: string;
  current_step_index: number;
  steps: Step[];
  started_at: string; // ISO-8601
  updated_at: string; // ISO-8601
  status: 'running' | 'complete' | 'aborted';
  /** Set when --manage-scripts gate is pending before the first step. */
  manage_scripts_pending?: boolean;
  /** Whether drift detection is in strict mode (--strict flag). */
  strict?: boolean;
  /** The tool expected from the last emitted instruction, for drift checking. */
  last_instructed_tool?: string;
  /** Byte offset into turn-log.jsonl up to which we've already processed. */
  turn_log_offset?: number;
  /** Set when a drift mismatch is detected in strict mode; gate pending. */
  drift_gate_pending?: {
    pending_report: Report;
    mismatch: { expected: string; actual: string };
  };
  /**
   * If set, this run is a subcommand (list/init/cleanup/create/expand-tools),
   * not a workflow. Step machinery is bypassed; routing happens via subcommand_state.
   */
  subcommand?: string;
  subcommand_state?: SubcommandState;
};

// ── Subcommands ───────────────────────────────────────────────────────────

export type CleanupTask = {
  name: string;
  command: string;
  description?: string;
};

export type AgentToolEntry = {
  add: string[];
  source?: string;
  configured_at?: string;
};

/** State for a multi-turn subcommand run. Discriminated by `kind` + `phase`. */
export type SubcommandState =
  // `list` has no continuation — emits `done` on start. No persisted state.
  | { kind: 'list'; phase: 'done' }
  // `cleanup` bare: iterate through configured tasks, bash per task.
  | {
      kind: 'cleanup';
      phase: 'running';
      tasks: CleanupTask[];
      index: number;
      passed: number;
      failed: number;
      skipped: number;
    }
  | {
      kind: 'cleanup';
      phase: 'task-failed';
      tasks: CleanupTask[];
      index: number;
      passed: number;
      failed: number;
      skipped: number;
      error_message: string;
    }
  // `cleanup --manage-tasks`: scan → propose → confirm → done.
  | { kind: 'cleanup-manage'; phase: 'scan' }
  | { kind: 'cleanup-manage'; phase: 'propose'; scan_result_path: string }
  | { kind: 'cleanup-manage'; phase: 'confirm'; proposed: CleanupTask[] }
  // `init`: scan → propose → confirm → write → done.
  | { kind: 'init'; phase: 'scan' }
  | { kind: 'init'; phase: 'propose'; scan_result_path: string }
  | { kind: 'init'; phase: 'confirm'; proposed_config: string }
  // `create`: ask-type (if missing) → gather → confirm → write.
  | { kind: 'create'; phase: 'ask-type' }
  | {
      kind: 'create';
      phase: 'gather';
      type: 'rule' | 'agent' | 'workflow';
      input_path: string;
    }
  | {
      kind: 'create';
      phase: 'confirm';
      type: 'rule' | 'agent' | 'workflow';
      name: string;
      draft: string;
      target_path: string;
    }
  // `expand-tools`: discover → propose → confirm → write.
  | { kind: 'expand-tools'; phase: 'discover' }
  | { kind: 'expand-tools'; phase: 'propose'; tools_path: string }
  | { kind: 'expand-tools'; phase: 'confirm'; proposal_path: string };

/**
 * Instruction emitted back to the LLM at every turn.
 *
 * `body` is the prose shown to the user/LLM. `report_with` is the exact CLI
 * invocation the LLM should run next (embedded in the stdout block). For
 * `done`, report_with is empty.
 */
export type InstructionKind = 'tool-call' | 'user-prompt' | 'bash' | 'done';

export type Instruction = {
  kind: InstructionKind;
  body: string;
  report_with?: string;
};

/**
 * Payload passed by the LLM to `ewh report`. Phase 1 accepts the
 * minimum (`--decision`, `--result`, `--abort`); richer forms are
 * added in later phases.
 */
export type Report =
  | { kind: 'decision'; step_index: number; decision: 'yes' | 'no' }
  | { kind: 'result'; step_index: number; result_path?: string }
  | { kind: 'error'; step_index: number; message: string }
  | { kind: 'abort' };
