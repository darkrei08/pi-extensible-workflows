# Evidence Report: Fresh v6-Compatible Solution for PR #293 (.worktreeinclude)

## Summary

Implemented a fresh, v6-compatible implementation of `.worktreeinclude` matching GitHub issue #291 and maintainer review guidance on pull request #293:

1. **Git-Native Pattern Matching**: Instead of a custom Minimatch-based evaluator, uses Git's own matching mechanisms via `git ls-files --others --ignored --exclude-from=.worktreeinclude -z` and `git check-ignore`.
2. **Single Manifest with Self-Copy**: Drops `.worktreeinclude.local`. Uses a single `.worktreeinclude` (tracked or untracked), which is itself copied to the target worktree so the new worktree contains the same manifest.
3. **Clean-Tree Preflight Exception**: Ignores uncommitted changes or untracked status of `.worktreeinclude` during the launch-tree clean preflight check, allowing a contributor to adjust `.worktreeinclude` without blocking worktree creation or dirtying git status.
4. **Validation and Guardrails**:
   - Rejects tracked files selected by `.worktreeinclude` with `WORKTREE_FAILED`.
   - Rejects untracked non-ignored files selected by `.worktreeinclude` with `WORKTREE_FAILED`.
   - Rejects destination escapes using canonical path checks on target directory.
   - Rejects unsafe symlinks: absolute symlinks and relative symlinks pointing outside repository root.
   - Rejects destination collisions on files other than the manifest itself.
   - Bounds copying to at most 500 files and 50 MB total with explicit `WORKTREE_FAILED` diagnostics.
5. **Lifecycle Semantics**:
   - Local context copying is limited to physical creation of fresh worktrees (`withWorktree()` and `subagents_run({ worktree })`).
   - Copying is skipped on named worktree reuse, borrowing from parent runs (`parentRunId`), retry lineages (`WorkflowRetryProvenance`), and cold resume (`disableWorktreeIncludes`).
   - Documented in `docs/developers.html`, `docs/subagents.html`, and `docs/llm.md`.

## Changed Files

- `packages/core/src/worktreeinclude.ts`: Core implementation of plan computation and file copying with safety checks.
- `packages/core/src/store.ts`: Integrated dirty-tree preflight filtering and conditional `.worktreeinclude` copying in `RunStore.worktree`. Added `disableWorktreeIncludes()`.
- `packages/core/src/host-recovery.ts`: Invoked `run.store.disableWorktreeIncludes()` on cold resume.
- `packages/core/subagents/src/worktree.ts`: Added optional `copyIncludes` to `SubagentWorktreeContext` and `SubagentWorktreeRunStore`.
- `packages/core/subagents/src/manager.ts`: Passed `copyIncludes: false` on subagent retry runs.
- `packages/core/test/persistence.test.ts`: Added comprehensive unit tests for matching, self-copy, dirty manifest, symlink safety, bounds, collisions, and lifecycle exclusions.
- `packages/core/subagents/test/index.test.mjs`: Added tests for subagent worktree copying and retry exclusion.
- `docs/developers.html`: Documented `.worktreeinclude` behavior, safety rules, and lifecycle semantics.
- `docs/subagents.html`: Documented `.worktreeinclude` in standalone subagents.
- `docs/llm.md`: Updated model-facing subagent documentation.
- `CHANGELOG.md`: Added entry under `Unreleased`.

## Verification Commands & Results

- `npm run build`: Success across all workspace packages (`@piewf/core`, `@piewf/cli`, `@piewf/herdr`).
- `node --test packages/core/dist/test/persistence.test.js packages/core/dist/test/lifecycle-controls.test.js packages/core/subagents/test/index.test.mjs`:
  All 161 tests passing (159 pass, 2 skipped Windows-only tests).
- `npm run lint` / checks: Completed cleanly without regressions.
