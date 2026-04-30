# Older Changes

## 0.2.13 (2026-04-19)

- Latest-repo review compliance: `common.messagebox=true` added because the admin-UI `Check Connection` and `Add Delivery` buttons route through `onMessage`. Runtime behaviour unchanged.

## 0.2.12 (2026-04-18)

- Harden API-drift guards in `ParcelClient` and `StateManager` (non-boolean `success`, non-array `deliveries`, non-string `error_code`/`error_message`, non-object carrier map, non-string delivery fields, numeric/string `status_code`, numeric-string `timestamp_expected`, malformed `events`)
- Add 38 regression tests (128 total) covering the new drift paths

## 0.2.11 (2026-04-12)

- Fix: handle response stream errors (prevents unhandled exceptions on connection drop)
- Fix: isolate per-delivery poll failures (one broken delivery no longer blocks all others)
- Fix: harden onMessage with try/catch and callback guard
- Fix: onUnload try/catch prevents adapter hang on shutdown
- DRY: parseStatus helper eliminates repeated parseInt calls
- Simplify obsolete state cleanup, use setObjectNotExistsAsync for states

## 0.2.10 (2026-04-12)

- Fix test timezone bug, remove unused devDependencies, add `no-floating-promises` lint rule.
- Remove redundant `actions/checkout` from CI workflow.

## 0.2.9 (2026-04-08)

- Standard ioBroker test suite added, test-build config optimised.

Older entries have been moved to [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## 0.2.8 (2026-04-05)

- Empty parent folders cleaned up after removing obsolete states.

## 0.2.7 (2026-04-05)

- Consistent UI labels across all adapters.

## 0.2.6 (2026-04-05)

- Redundant scripts removed, documentation compressed.

## 0.2.5 (2026-04-04)

- Delivery window timeout on Windows fixed (deterministic time formatting).

## 0.2.4 (2026-04-03)

- Dev tooling modernised — esbuild, TypeScript 5.9 pin, testing-action-check v2.

## 0.2.3 (2026-03-28)

- Carrier-name cache no longer fails forever after the initial fetch error — retries on next call.

## 0.2.2 (2026-03-28)

- Adapter-managed timers (`this.setInterval` / `this.clearInterval`).
- Windows and macOS added to CI test matrix.
- Consistent admin UI i18n keys (`supportHeader`).
- Full MIT license text in README.

## 0.2.1 (2026-03-25)

- API rate-limit detection (HTTP 429) with automatic cooldown.
- Connection-error deduplication to prevent log spam during outages.
- Poll throttling (minimum 60 s between requests).
- Error classification improved for network, timeout, and API errors.

## 0.2.0 (2026-03-25)

- Option to keep delivered packages in states instead of auto-removing.
- Admin UI simplified from tabs to single-page layout.
- Redundant `summary.json` state removed.
- Filter-mode setting removed (now automatic based on delivery behaviour).

## 0.1.5 (2026-03-24)

- `auto-merge.yml` config added.
- Dependabot schedule changed from monthly to weekly.
- `actions/checkout` updated to v6.

## 0.1.4 (2026-03-24)

- README clarified — ioBroker adapter framing and feature descriptions.

## 0.1.3 (2026-03-24)

- Auto-merge workflow for Dependabot PRs.
- Dependabot schedule time randomised for load distribution.

## 0.1.2 (2026-03-23)

- devDependencies updated (`@iobroker/build-tools` 3.x, `@types/node` 25.x).

## 0.1.1 (2026-03-23)

- Adapter logo redesigned (cardboard package with tracking pin).
- Repochecker issues fixed (dependabot config, test artefacts, mocha dependency).

## 0.1.0 (2026-03-23)

- Initial release.
- Tracks packages from 300+ carriers via the parcel.app API.
- Admin UI with connection test, polling settings, donation tab.
- Automatic cleanup of delivered packages.
- Combined delivery window for today's deliveries.
- Summary states (active count, today count, delivery window, JSON).
- Multilingual status labels (German/English).
- Add-delivery support via `sendTo` message.
