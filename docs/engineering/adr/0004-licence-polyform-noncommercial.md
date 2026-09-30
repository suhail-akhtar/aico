# 0004 — Licence: PolyForm Noncommercial 1.0.0 from 0.28.0

- **Status:** Accepted (2026-09-29, shipped in 0.28.0)
- **Deciders:** owner

## Context

AICO was MIT-licensed up to 0.27.x. The owner wants personal, study, research
and noncommercial use to stay free, commercial use to require a licence, and
every fork or copy to credit the original project visibly.

## Decision

- From 0.28.0 AICO is licensed under **PolyForm Noncommercial 1.0.0**. SPDX
  `PolyForm-Noncommercial-1.0.0` in `package.json`, `desktop/package.json` and
  `vscode-extension/package.json`; a copy of `LICENSE` in `vscode-extension/`.
- `LICENSE` opens with a plain-words summary and three `Required Notice:`
  lines (copyright; original source URL; forks must keep the notices and
  visibly credit "AICO by Suhail Akhtar" with a link). PolyForm's Notices
  clause obliges recipients to pass those lines on — that is how the
  attribution requirement is enforced.
- Releases before 0.28.0 remain MIT; that grant cannot be revoked, and
  `LICENSE`, README and the CHANGELOG say so.
- Wording everywhere: **source-available**, "free for personal use". Never
  "open source", never "MIT" for the current project.
- Commercial licensing requests go through GitHub issues (no personal contact
  details published).

## Alternatives considered

| Option | Why not |
|---|---|
| Stay MIT | permits commercial resale/hosting the owner does not want |
| AGPL / other OSI licence | OSI licences cannot forbid commercial use |
| Custom licence | unvetted legal text; PolyForm is a maintained standard family |

## Consequences

- **Good:** clear terms; attribution travels with forks.
- **Costs:** the project cannot be described as open source; some users and
  companies cannot adopt it; contributions are accepted under the same licence.
- **Dependencies:** third-party packages keep their own licences; a new
  dependency must be compatible with distribution under this licence.

## Verification

`scripts/check-standards.mjs` fails on a package declaring another licence and
on "open source"/MIT claims in our own Markdown/HTML (history lines that say
"before 0.28.0" are allowed; a deliberate exception carries
`standards-allow: licence`).
