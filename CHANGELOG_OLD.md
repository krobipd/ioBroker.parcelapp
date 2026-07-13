# Older Changes
## 0.7.1 (2026-06-09)

- Fixed a timezone edge case in delivery estimates: when the API reports only a calendar date, the estimate could be off by a day in time zones west of UTC — now stable everywhere.

## 0.7.0 (2026-06-07)

- Added optional Sentry error reporting: crashes are sent to the developer so issues get fixed faster. Active only with ioBroker diagnostics enabled; anonymous.

## 0.6.0 (2026-05-31)

- The summary delivery window now covers the full time range when several packages are expected the same day — previously an overlapping window could be cut short.
- Packages reported with an unrecognized status are no longer mistaken for delivered and removed; they stay visible as "Unknown".
- A delivery added via the admin button now appears immediately instead of only after the next polling cycle.

## 0.5.3 (2026-05-23) — stable

- Reduced unnecessary state-change events by skipping writes when the value has not changed.

## 0.5.2 (2026-05-23)

- Changelog rewritten in user-centric style across all versions.

## 0.5.1 (2026-05-23)

- Internal cleanup. No user-facing changes.

## 0.5.0 (2026-05-22)

- User-modified state names are no longer overwritten on adapter restart

## 0.4.9 (2026-05-21)

- Improved error handling and stability.

## 0.4.8 (2026-05-19)

- Internal cleanup. No user-facing changes.

## 0.4.7 (2026-05-17)

- Internal cleanup. No user-facing changes.

## 0.4.6 (2026-05-17)

- Localized "Adapter Information" and "Connection status" labels into 11 languages — previously English only.

## 0.4.5 (2026-05-17)

- Fixed adapter icon not displaying in some admin environments (Content Security Policy).

## 0.4.4 (2026-05-13)

- Adapter shuts down cleanly even if the "Test Connection" button was still running — the test request is now aborted at unload along with regular polling.

## 0.4.3 (2026-05-13)

- Improved debug logging for easier diagnosis of API and delivery tracking issues.

## 0.4.2 (2026-05-10)

- Adapter shuts down cleanly even if parcel.app is slow — pending requests are aborted instead of hanging until kill.
- "Forbidden" responses (e.g. when the Premium subscription is no longer active) now log a clear hint pointing to your parcel.app account, instead of looping reauth as if the API key were just wrong.
- Two parcels whose tracking numbers differ only in special characters no longer overwrite each other in the state tree — the second one gets a hash suffix.
- Invalid poll-interval values can no longer turn into a tight loop; rate-limit cooldowns can no longer get stuck near zero.

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

- Improved crash resilience — unexpected errors are now caught and the adapter restarts cleanly.

## 0.2.14 (2026-04-23)

- Status labels are now localized in 11 languages following the ioBroker system language. Fix: today-count works across all languages.

## 0.2.13 (2026-04-19)

- Internal cleanup. No user-facing changes.

## 0.2.12 (2026-04-18)

- Malformed API responses no longer crash the adapter.

## 0.2.11 (2026-04-12)

- Improved error handling and stability.

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

- API rate-limit detection with automatic cooldown. Fewer duplicate error messages in the log.

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
