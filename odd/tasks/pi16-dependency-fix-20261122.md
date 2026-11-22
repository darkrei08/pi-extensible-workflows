Feature: pi16-dependency-fix
Branch: fix/pi-1.6-dependencies (from origin/main efa9c5a)

## Specs
1. S1: "Spacchettala i-extensible-workflows #11: CLOSED - chiusa come superseded perché troppo ampia e in conflitto. Rioslvo Blocco residuo Il check richiesto di #12 fallisce per un difetto preesistente su main: @piewf/cli@6.3.0 installa @earendil-works/pi-coding-agent@1.0.0. Quest'ultimo risolve @earendil-works/pi-codemode@1.6.0. pi-codemode@1.6.0 ha rimosso export ancora usati da pi-coding-agent@1.0.0. npm audit segnala anche advisory minimatch e undici. Ho aperto issue #13. Eliminali se non necessario. E dimmi in quale stato di avanzamento è il commit di fast rist enfurhing"
2. S2: "npm audit segnala anche advisory minimatch e undici."
3. S3: "Spacchettala" - keep the Pi 1.6.0 dependency fix separate from the role-docs PR #12.

## Tasks
- T1 | S1-S3 | Bump Pi packages to 1.6.0 and update lockfile | commit: pending
- T2 | S2 | Clear minimatch/undici audit exceptions safely | commit: pending
- T3 | S1-S3 | Verify package checks, typecheck and tests | commit: pending

## Log
- L1: "Spacchettala i-extensible-workflows #11: CLOSED - chiusa come superseded perché troppo ampia e in conflitto. Rioslvo Blocco residuo Il check richiesto di #12 fallisce per un difetto preesistente su main: @piewf/cli@6.3.0 installa @earendil-works/pi-coding-agent@1.0.0. Quest'ultimo risolve @earendil-works/pi-codemode@1.6.0. pi-codemode@1.6.0 ha rimosso export ancora usati da pi-coding-agent@1.0.0. npm audit segnala anche advisory minimatch e undici. Ho aperto issue #13. Eliminali se non necessario. E dimmi in quale stato di avanzamento è il commit di fast rist enfurhing"
- L2: Discovery found no commit matching 'fast rist enfurhing'; closest are feat/fast-anything-integration and 'enforce LF' / 'restore' commits.
- L3: Applied upstream 1.5.2 compatibility source changes and raised Pi runtime pins to 1.6.0, TypeBox to 1.3.27, minimatch to 11.0.8, dropped pi-server, and removed audit exemptions.
- L4: Regenerated package-lock.json with npm install --package-lock-only after scoped user authorization. npm ci in isolated worktree succeeded with Pi 1.6.0 and undici 8.12.4.
- L5: Verification: npm run build PASS, npm run lint PASS, npm run test:packages PASS. Full npm test still has pre-existing host-dependent failures: resource-policy tests see host skills, and Chromium trajectory tests need a working browser context. CI check on PR #12 previously passed npm run check and failed only test:packages.
