# Older Changes

## 0.2.5 (2026-04-04)

- Fix delivery window timeout on Windows (deterministic time formatting)

## 0.2.4 (2026-04-03)

- Modernize dev tooling (esbuild, TypeScript 5.9 pin, testing-action-check v2)

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

## 0.1.5 (2026-03-24)

- Added auto-merge.yml config
- Changed Dependabot schedule from monthly to weekly
- Updated actions/checkout to v6

## 0.1.4 (2026-03-24)

- Improved README: clearer ioBroker adapter framing and feature descriptions

## 0.1.3 (2026-03-24)

- Added automerge workflow for Dependabot PRs
- Randomized Dependabot schedule time for load distribution

## 0.1.2 (2026-03-23)

- Updated devDependencies (@iobroker/build-tools 3.x, @types/node 25.x)

## 0.1.1 (2026-03-23)

- Redesigned adapter logo (cardboard package with tracking pin)
- Fixed repochecker issues (dependabot config, test artifacts, mocha dependency)

## 0.1.0 (2026-03-23)

- Initial release
- Track packages from 300+ carriers via parcel.app API
- Admin UI with connection test, polling settings, and donation tab
- Automatic cleanup of delivered packages
- Combined delivery window for today's deliveries
- Summary states (active count, today count, delivery window, JSON)
- Multilingual status labels (German/English)
- Add delivery support via sendTo message
