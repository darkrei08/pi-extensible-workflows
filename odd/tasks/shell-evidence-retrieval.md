# Shell evidence retrieval
Issue #343 implementation slice for automatic bounded shell-output offloading and replay-safe retrieval.
Source repository: `pi-extensible-workflows`; work unit branch: `feat/shell-evidence-offloading`.

## Specs

S1. User: "Permanently resolve Bash execution and output limits"

S2. User: "Design and implement a reusable execution abstraction that supports:

* Unlimited logical result retrieval through bounded pagination.
* Persistent stdout and stderr artifacts.
* Configurable output and token budgets.
* Cursor-based retrieval and deterministic ordering.
* Structured JSON output and compact summaries.
* Automatic truncation detection.
* Incremental processing of large outputs.
* Command cancellation, timeouts, retries, and recovery.
* Full preservation of exit codes and error information.
* Efficient searching and filtering before returning data to the LLM."

S3. User: "Never solve the problem by indiscriminately increasing context consumption."

S4. User: "Implement compatibility adapters only where necessary and justified."

S5. Existing issue #343 acceptance: large shell commands must be streamed to run-scoped evidence before the 10 MB RPC boundary; small results remain unchanged; cancellation, timeout, replay, journal integrity, Unicode, stderr, non-zero exits, and bounded page reads remain verifiable.

## Tasks

- T1 [S1-S5] Replace opt-in-only shell artifact capture with automatic threshold-based spill, bounded UTF-8-safe tails, explicit truncation metadata, hard stream/run caps, and compact evidence references. Route: core execution and public types. Commit: 1c45e0a.
- T2 [S1-S5] Store large shell results compactly in the replay journal while preserving legacy inline entries and reconstructing non-truncated values on replay. Route: host and persistence. Commit: 1c45e0a.
- T3 [S1-S5] Add focused regression tests for automatic spill, journal compaction, replay, tamper detection, Unicode, cancellation, timeout, exit codes, stderr, caps, and bounded reads; update package docs, developer docs, LLM docs, and changelog. Route: tests and documentation. Commit: 1c45e0a.
- T4 [S1-S5] Run focused and full repository verification, inspect the final diff, and prepare an issue-linked PR without merging or publishing. Route: verification and delivery preparation. Commit: 1c45e0a.

Verification before commit: core build and lint pass; focused persistence, retention, trust-boundary, and workflow-runtime tests pass; `git diff --check` passes. Commit 1c45e0a contains the reviewed implementation and ODD artifacts. Full repository checks remain pending.

## Log

L1. User request verbatim: "Start immediately with actual environment and repository discovery. Do not ask for information that can be determined through available tools. Implement improvements incrementally, validate every significant change, and prepare pull requests only after the relevant quality gates pass."
L2. Discovery verified that `/root/git/personale/pi-extensible-workflows` is a fork with `origin=https://github.com/darkrei08/pi-extensible-workflows.git` and `upstream=https://github.com/vekexasia/pi-extensible-workflows.git`, issue #343 is open, and branch `feat/shell-evidence-offloading` already contains an initial opt-in implementation plus uncommitted trust-boundary hardening. The current focused core build/tests passed, but the implementation does not yet satisfy the maintainer's automatic tail and compact-journal direction.
L3. The implementation must preserve the pre-existing dirty scope and must not touch unrelated repositories or the pre-existing untracked report in `/root/git/personale/pi-model-fit`.
L4. Focused verification completed before delivery preparation: `npm run build --workspace=packages/core`, `npm run lint --workspace=packages/core`, `TEST_FILES='dist/test/persistence.test.js dist/test/retention.test.js dist/test/trust-boundaries.test.js dist/test/workflow-runtime.test.js' npm run test:run --workspace=packages/core`, and `git diff --check` all exited 0. No source correction was required after inspection; the remaining full-suite failures are not yet re-run in this session.
L5. Commit evidence: commit `1c45e0a` (`feat(core): stream oversized shell output into evidence`) contains T1-T4 and the synchronized task artifacts. No push, merge, or pull request was performed.
