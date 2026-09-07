# Changelog

All notable changes to the Daedalus harness are documented here. The format is
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); the version is
[SemVer](https://semver.org/) and lives in the root `package.json` — bump it in
the same commit as the new entry. The server parses this file for
`GET /api/meta` (Settings › General shows it), and reads it line by line: keep
each bullet on a single line.

## [Unreleased]

## [0.1.0] - 2026-09-07

### Added

- One app version, in the root `package.json` — the harness is one product deployed together, so the client's build id and the server's `/api/meta` read the same number.
- This changelog, served parsed by `GET /api/meta` and browsable in Settings › General › What's new.
