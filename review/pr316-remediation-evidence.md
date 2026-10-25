# PR316 bounded remediation

Base: current upstream `main` merged at `2855283` on the replacement branch. Linux host, Node v22.23.3, `/usr/bin/chromium`.

## Changes

- Renderer tests adopt Chrome-selected debugging ports, stderr endpoint discovery, 30-second startup diagnostics, and explicit `Page.navigate` after attaching to the DevTools page target. This avoids the race where Chrome exposes an initial `about:blank` target before the requested fixture is loaded.
- Heap trend subtracts baseline-relative control growth at each corresponding sample. It uses the smaller of the two controls, matching the existing conservative control correction. The parent heap criterion evaluates control-corrected growth while retaining raw excess and deltas in evidence. Tolerance, 10 warm-up / 50 measured cycles, JIT, retention checks and security checks are unchanged.
- Focused regressions cover shared warm-up, persistent excess and a nonmonotonic corrected series.
- Current-main merge conflicts were resolved without dropping the Semantic Map installed-consumer checks or current Trajectory browser coverage; generated asset fingerprints were rebuilt.

## Verification

- `git merge upstream/main`: resolved and committed as `2855283`.
- `npm run build`: passed.
- `npm run lint`: passed.
- `npm run docs:check`: passed.
- `node --test packages/core/dist/trajectory/test/semantic-map-browser.test.js`: passed.
- `node --test scripts/trajectory-semantic-map-acceptance.test.mjs`: 4 passed, 0 failed, 0 skipped.
- `PI_TRAJECTORY_CHROME=/usr/bin/chromium node scripts/trajectory-semantic-map-acceptance.mjs --phases heap --out /tmp/pr316-merge-heap`: 3/3 heap criteria passed using the original 10 warm-up / 50 measured-cycle protocol. The current-main candidate fixed tolerance was 54,378 B; candidate growth 86,624 B; raw excess 50,708 B; control-corrected growth 50,708 B; corrected deltas 12,792 / 740 / 16,824 / 19,724 / 628 B; retention and fresh-iframe checks passed.
- `git diff --check`: passed.

## Limits

No all-phases acceptance, 600-second ordinary-update soak, Windows or container matrix was run. The full repository suite remains environment-sensitive in this host: global skill discovery contaminates resource-policy tests, the worktree-local `jiti` path is missing for one loader test, and concurrent browser tests can time out. These results are recorded rather than hidden.
