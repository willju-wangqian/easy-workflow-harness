---
name: doit
description: "Easy Workflow Harness dispatcher (v2, binary-backed). Runs workflows by invoking the ewh Node binary and executing one action at a time."
user-invocable: true
---

!`ewh start "$ARGUMENTS"`

# doit — Binary-Backed Dispatcher

## Turn Protocol

You are the executor in a two-party loop with the `ewh` binary. The binary
holds all orchestration state; you only run the single tool call it names,
then report the result back.

**First instruction** is pre-baked via shell injection at the top of this
skill (`` !`ewh start "$ARGUMENTS"` ``) so there is no wasted turn. Read the
`ACTION:` block in that output and then follow the loop below.

## The Loop

Repeat until you see `ACTION: done`:

1. Read the emitted `ACTION:` block. It has the shape:

       ACTION: <tool-call | user-prompt | bash | done>
       <body — prose telling you what to do>
       REPORT_WITH: ewh report --run <id> --step <i> [flags]

2. Execute the action:
   - **tool-call** — invoke the named tool with the listed args. For
     subagents, the body will tell you to save the final assistant
     message to a result file.
   - **user-prompt** — show the body to the user and wait for their
     answer (yes/no for gates, free-form otherwise).
   - **bash** — run the named command via `Bash`.
   - **done** — the run is complete. Show the body verbatim to the user
     (it contains the run summary or, for `list`-style subcommands, the
     catalog the user asked for), then exit the loop. Do not paraphrase,
     truncate, or add a "catalog above" / "already shown" hand-wave —
     the body is not visible to the user until you display it.

3. Run the exact `REPORT_WITH:` invocation using `Bash`. Add flags as
   the binary hints in the body:
   - `--result <path>` when a tool call wrote an output file.
   - `--decision yes` / `--decision no` for user-prompt gates.
   - `--error "<msg>"` if the tool call crashed.
   - `--abort` if the user asks to stop.

4. The stdout of `ewh report` is the next `ACTION:` block. Go to step 1.

## Ground Rules

- Never infer or skip a step. Every action the binary names must be
  executed and reported — including `user-prompt` gates. If you are
  unsure what to do, ask the user and report their answer.
- Never edit `.ewh-artifacts/<run>/state.json` by hand. The binary owns
  it; corrupting it aborts the run.
- If `ewh report` fails with a non-zero exit, show the stderr to the
  user verbatim and stop. Do not retry with different flags.
- If the user interrupts the loop, run
  `ewh report --run <id> --step <i> --abort` before returning control.

## Crash / Resume

If the binary crashes mid-transition or your session disconnects, the
next `ewh start` for the same workflow detects the stale
`.ewh-artifacts/<run>/ACTIVE` marker and prompts the user to resume or
clear. You do not need to handle this yourself — just re-run the skill.
