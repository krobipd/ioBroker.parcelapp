# Changelog

## 0.2.8 (2026-04-05)

- Clean up empty parent folders after removing obsolete states

## 0.2.7 (2026-04-05)

- Consistent UI labels across all adapters

## 0.2.6 (2026-04-05)

- Remove redundant `build:ts` and `prepare` scripts
- Compress CLAUDE.md documentation (204 → 72 lines)

## 0.2.5 (2026-04-04)

- Fix delivery window test timeout on Windows (replace `toLocaleTimeString` with deterministic formatting)

## 0.2.4 (2026-04-03)

- Modernize dev tooling: esbuild via build-adapter, @tsconfig/node20, rimraf, TypeScript ~5.9.3 pin
- Upgrade testing-action-check to v2.0.0
- Dependabot: monthly schedule, auto-merge skips major updates
- Branch protection: require check-and-lint status check

## 0.2.3 (2026-03-28)

- Fix carrier name cache not retrying after initial failure

## 0.2.2 (2026-03-28)

- Switched to adapter-managed timers (this.setInterval/this.clearInterval)
- Added Windows and macOS to CI test matrix
- Consistent admin UI i18n keys (supportHeader)
- Full MIT license text in README

## 0.2.1 (2026-03-25)

- Added API rate limit detection (HTTP 429) with automatic cooldown
- Added connection error deduplication to prevent log spam during outages
- Added poll throttling (minimum 60s between requests)
- Improved error classification for network, timeout, and API errors

## 0.2.0 (2026-03-25)

- Added option to keep delivered packages in states instead of auto-removing
- Simplified admin UI from tabs to single page layout
- Removed redundant summary.json state
- Removed filter mode setting (now automatic based on delivery behavior)

Older changes: [CHANGELOG_OLD.md](CHANGELOG_OLD.md)
