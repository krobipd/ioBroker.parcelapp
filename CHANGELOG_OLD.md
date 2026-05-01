# Older Changes
## 0.2.14 (2026-04-23)
- Status labels localized via `system.config.language` (11 languages). Fix: `summary.todayCount` for non-DE/EN.

## 0.2.13 (2026-04-19)
- Internal: `common.messagebox=true` (admin-UI button routing).

## 0.2.12 (2026-04-18)
- API-drift hardening in `ParcelClient` and `StateManager`. +38 regression tests.

## 0.2.11 (2026-04-12)
- Fix: response-stream errors handled, per-delivery poll failures isolated, safer `onMessage`/`onUnload`.

## 0.2.10 (2026-04-12)
- Internal cleanup.

## 0.2.9 (2026-04-08)
- Standard ioBroker test suite added.

## 0.2.8 (2026-04-05)
- Empty parent folders cleaned after obsolete-state removal.

## 0.2.7 (2026-04-05)
- Internal: consistent UI labels.

## 0.2.6 (2026-04-05)
- Internal cleanup.

## 0.2.5 (2026-04-04)
- Fix: delivery-window timeout on Windows.

## 0.2.4 (2026-04-03)
- Internal dev-tooling modernization.

## 0.2.3 (2026-03-28)
- Fix: carrier-name cache retries after initial error.

## 0.2.2 (2026-03-28)
- Adapter-managed timers; Windows + macOS in CI.

## 0.2.1 (2026-03-25)
- API rate-limit detection (HTTP 429) with cooldown. Connection-error deduplication. Poll throttling (60 s minimum).

## 0.2.0 (2026-03-25)
- Optional keep-delivered packages. Admin UI simplified to single page.

## 0.1.5 (2026-03-24)
- Internal: dependabot schedule + actions update.

## 0.1.4 (2026-03-24)
- README clarified.

## 0.1.3 (2026-03-24)
- Auto-merge workflow for Dependabot PRs.

## 0.1.2 (2026-03-23)
- devDependencies update.

## 0.1.1 (2026-03-23)
- Adapter logo redesigned. Repochecker fixes.

## 0.1.0 (2026-03-23)
- Initial release. Package tracking via parcel.app API.
