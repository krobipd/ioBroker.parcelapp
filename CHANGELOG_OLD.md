# Older Changes
## 0.4.4 (2026-05-13)

- Adapter shuts down cleanly even if the "Test Connection" button was still running — the test request is now aborted at unload along with regular polling.

## 0.4.3 (2026-05-13)

- Debug log now traces previously silent paths: HTTPS request lifecycle, carrier-list fetch outcome, per-delivery updates, admin-message handling and lifecycle anchors. Default log unchanged.

## 0.4.2 (2026-05-10)

- Adapter shuts down cleanly even if parcel.app is slow — pending requests are aborted instead of hanging until kill.
- "Forbidden" responses (e.g. when the Premium subscription is no longer active) now log a clear hint pointing to your parcel.app account, instead of looping reauth as if the API key were just wrong.
- Two parcels whose tracking numbers differ only in special characters no longer overwrite each other in the state tree — the second one gets a hash suffix.
- Defensive: bogus poll-interval values can no longer turn into a tight loop hammering the API; rate-limit cooldowns can no longer get stuck near zero.

## 0.4.1 (2026-05-09)

- Adapter log messages are now English only, in line with the ioBroker community standard. Localized state names (11 languages) are unchanged.

## 0.4.0 (2026-05-06)

- State names now follow your ioBroker system language (11 languages).
- Minimum requirements: Node.js 22 and ioBroker Admin 7.8.23.

## 0.3.2 (2026-05-01)

- Documentation polish across all languages.

## 0.3.1 (2026-05-01)

- Documentation polish.

## 0.3.0 (2026-04-30)

- Internal cleanup. No user-facing changes.

## 0.2.18 (2026-04-28)

- Internal cleanup. No user-facing changes.

## 0.2.17 (2026-04-28)

- Internal cleanup. No user-facing changes.

## 0.2.16 (2026-04-26)

- Min `js-controller` restored to `>=6.0.11` (was incorrectly bumped to `>=7.0.23` in 0.2.15).

## 0.2.15 (2026-04-26)

- Crash defense: process-level error handlers catch unexpected errors and restart cleanly.

## 0.2.14 (2026-04-23)

- Status labels are now localized in 11 languages following the ioBroker system language. Fix: today-count works across all languages.

## 0.2.13 (2026-04-19)

- Internal cleanup. No user-facing changes.

## 0.2.12 (2026-04-18)

- API-drift hardening: malformed responses no longer crash the adapter.

## 0.2.11 (2026-04-12)

- Fix: response-stream errors handled, per-delivery poll failures isolated, safer message and unload handling.

## 0.2.10 (2026-04-12)

- Internal cleanup. No user-facing changes.

## 0.2.9 (2026-04-08)

- Internal cleanup. No user-facing changes.

## 0.2.8 (2026-04-05)

- Empty parent folders are now cleaned after obsolete-state removal.

## 0.2.7 (2026-04-05)

- Internal cleanup. No user-facing changes.

## 0.2.6 (2026-04-05)

- Internal cleanup. No user-facing changes.

## 0.2.5 (2026-04-04)

- Fix: delivery-window timeout on Windows.

## 0.2.4 (2026-04-03)

- Internal cleanup. No user-facing changes.

## 0.2.3 (2026-03-28)

- Fix: carrier-name cache retries after initial error.

## 0.2.2 (2026-03-28)

- Internal cleanup. No user-facing changes.

## 0.2.1 (2026-03-25)

- API rate-limit detection (HTTP 429) with cooldown. Connection-error deduplication. Poll throttling.

## 0.2.0 (2026-03-25)

- Optional keep-delivered packages. Admin UI simplified to a single page.

## 0.1.5 (2026-03-24)

- Internal cleanup. No user-facing changes.

## 0.1.4 (2026-03-24)

- README clarified.

## 0.1.3 (2026-03-24)

- Internal cleanup. No user-facing changes.

## 0.1.2 (2026-03-23)

- Internal cleanup. No user-facing changes.

## 0.1.1 (2026-03-23)

- Adapter logo redesigned.

## 0.1.0 (2026-03-23)

- Initial release. Package tracking via parcel.app API.
