# Deterministic full checks
Repository work unit for eliminating environment-dependent full-suite failures in `pi-extensible-workflows`.
Source repository: `pi-extensible-workflows`; work unit branch: `feat/shell-evidence-offloading`.

## Specs

S1. User: "procedi ad una solusione definitiva facendo uso di pi herdr orchestrartion e pi exentible workjflow avaindo altre sessioni pid di test eccetera"

S2. The full repository check must not discover the operator's ambient installed skills when tests create isolated agent homes.

S3. Trajectory polling tests must remain deterministic under the repository's parallel test runner and must not fail because their bounded polling budget is shorter than normal CI or host scheduling delays.

S4. Chromium trajectory tests must wait for the requested page to become the active document before asserting application state; browser startup and test cleanup must remain bounded.

S5. Preserve production behavior and public contracts. Change only test isolation, test timing, or test-fixture startup needed to remove confirmed environment-dependent failures.

S6. Verification must include focused red/green regressions, build, lint, full repository check, clean-worktree inspection, and native review before delivery. Do not push or open a pull request.

## Tasks

- T1 [S1-S2] Isolate the core test runner's HOME and related user resource roots per test process so ambient skills cannot enter fixture discovery. Route: `packages/core/package.json` and test runner environment. Commit: `18f11b9`.
- T2 [S1-S3] Replace the fixed issue #105 polling budget with a bounded scheduler-tolerant wait that remains deterministic and reports the same failure. Route: `packages/core/test/support.ts`. Commit: `18f11b9`.
- T3 [S1-S4] Make Chromium trajectory fixtures navigate away from `about:blank` before page-state assertions while retaining bounded CDP startup and cleanup. Route: `packages/core/trajectory/test/trajectory-browser.test.ts`. Commit: `18f11b9`.
- T4 [S1-S6] Run focused red/green checks, lint/build, the full repository check, native review, and reconcile temporary sessions/processes. Route: verification and delivery. Commit: `18f11b9`.

## Log

L1. User request verbatim: "procedi ad una solusione definitiva facendo uso di pi herdr orchestrartion e pi exentible workjflow avaindo altre sessioni pid di test eccetera"
L2. Read-only Pi Workflow diagnosis completed in workflow `140e11ff-6d13-4528-bbc8-66b76211f024`: confirmed ambient skill discovery caused resource-policy failures, the issue #105 helper's effective wait budget was about five seconds under `-P20`, and Chromium tests that started at `about:blank` raced application initialization. No files were changed by the diagnostic workflow.
L3. Parent spot-check confirmed the relevant runner, helper, and browser fixture files. The target worktree was clean before this feature record; prior shell-evidence commits remain `1c45e0a` and `050007e`.
L4. Focused red/green evidence: the four resource-selector files failed before the runner HOME isolation and passed after it; `trajectory-load.test.js` passed after the scheduler-tolerant polling change. A read-only Chromium workflow reproduction confirmed Chromium reported the expected target URL while the connected document was still `about:blank` and the fixture server had received no request; the fix must explicitly navigate after CDP connection.
L5. A second read-only workflow reproduction confirmed the browser-file timeout was the root test's cumulative 120-second budget under serial Chromium subtests: the first four tests consumed about 104 seconds and the fifth was cancelled, while the fifth passed alone. The runner timeout is therefore 300000 ms; the bounded process parallelism remains `-P4` and browser process groups are explicitly signaled during normal cleanup.
L6. Herdr verification passed the focused resource/polling set, trajectory browser file (`7/7`), and Herdr trajectory integration (`4/4`) after preserving the authenticated operator HOME for `test:herdr`; the non-auth core runners retain isolated HOME and agent roots. Build and lint passed. The root `npm run check` reached the CLI suite and reproducibly failed only in pre-existing `doctor-cleanup` evidence tests: tampered bytes report byte-count corruption instead of checksum mismatch, and the read-count assertion reports `0` instead of `4`. A concurrent build/test attempt also produced a transient missing `dist/trajectory/src/assets/index.html`; no concurrent build was used for the successful browser run.
L7. Work unit `18f11b9` received native review lineage `review-179f3bd10eda2fdf` across risk, resilience, and reliability; all three reviewers were submitted and the exact acknowledgement completed with native authority burned. No push or pull request was performed.
