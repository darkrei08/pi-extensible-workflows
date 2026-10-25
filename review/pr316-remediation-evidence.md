# PR316 bounded remediation

Base: c3ec306. Linux host, Node v22.23.3, /usr/bin/chromium.

## Changes

- Renderer test adopts current upstream/main's Chrome-selected debugging port, stderr endpoint discovery, 30-second startup budget, bounded HTTP requests and startup diagnostics. Fixture errors are now reported rather than reduced to a missing-object assertion.
- Heap trend subtracts baseline-relative control growth at each corresponding sample. It uses the smaller of the two controls, matching the existing conservative final-excess rule. The parent heap criterion now evaluates that control-corrected growth, while retaining raw excess and raw deltas in evidence. Tolerance, 10 warm-up / 50 measured cycles, JIT, retention checks and security checks are unchanged.
- Focused regressions cover measured shared warm-up, persistent excess and a nonmonotonic corrected series.

## Verification

- `npm run build`: pass.
- `npm run lint`: pass.
- `npm run docs:check`: pass.
- `node --test packages/core/dist/trajectory/test/semantic-map-browser.test.js scripts/trajectory-semantic-map-acceptance.test.mjs`: 5 passed, 0 failed, 0 skipped.
- `git diff --check`: pass.
- `PI_TRAJECTORY_CHROME=/usr/bin/chromium node scripts/trajectory-semantic-map-acceptance.mjs --phases heap --out /tmp/pr316-final2`: passed all 3 heap criteria with the original 10 warm-up / 50 measured-cycle protocol. Controls grew 33,792 / 36,188 B, candidate grew 86,260 B, raw excess was 52,468 B, control-corrected growth was 52,468 B within the fixed 54,282 B tolerance, corrected deltas were 13,356 / 720 / 16,244 / 17,456 / 4,692 B, and retention/fresh-iframe checks passed.

## Limits

No all-phases acceptance, 600-second ordinary-update soak, parallel browser stress, full test suite, Windows or container matrix was run. No GitHub mutation has been performed from this worktree. The reviewable branch still requires commit, push and PR reconciliation.
