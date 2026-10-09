# 0036 — Licence: Functional Source License 1.1 (Apache 2.0 future licence) from 0.48.0

- **Status:** Accepted (2026-10-09, takes effect with 0.48.0)
- **Date:** 2026-10-09
- **Deciders:** owner
- **Supersedes / related:** supersedes [0004](0004-licence-polyform-noncommercial.md) for 0.48.0 and later; 0004 remains the record of 0.28.0–0.47.x

## Context

AICO has had three licences:

| Releases | Licence |
|---|---|
| before 0.28.0 | MIT |
| 0.28.0 – 0.47.x | PolyForm Noncommercial 1.0.0 ([0004](0004-licence-polyform-noncommercial.md)) |
| 0.48.0 and later | Functional Source License 1.1, Apache 2.0 future licence (**FSL-1.1-ALv2**) — this ADR |

PolyForm Noncommercial let individuals use AICO but made it unusable for a
company: any use "inside a business for commercial advantage" needed a separate
licence, so enterprises could not even evaluate it on real work. The agreed
plan is an **AICO Control** server for organisations (policy, audit, fleet
management) built on the managed-policy and audit work of
[0035](0035-managed-policy-and-audit-export.md). That plan needs companies to be
able to adopt the agent first, and needs the owner to keep the right to sell the
organisation product without a third party reselling the same thing.

## Decision

- From **0.48.0** AICO is licensed under **FSL-1.1-ALv2**. SPDX `FSL-1.1-ALv2`
  in `package.json`, `desktop/package.json` and `vscode-extension/package.json`
  (and the root records of their lockfiles); `LICENSE` and
  `vscode-extension/LICENSE` carry a short plain-words preamble followed by the
  official FSL text, verbatim, with only the year (2026) and licensor name
  (Suhail Akhtar) filled in.
- What it allows: use, copy, modify, redistribute and run AICO for **any
  purpose except a Competing Use** — including inside a company, for client
  work, and for professional services around AICO. A Competing Use is making
  AICO available to others in a commercial product or service that substitutes
  for it, substitutes for another product or service we offer using it, or
  offers the same or substantially similar functionality.
- **Each version converts to Apache 2.0 on the second anniversary** of the date
  it was made available. The grant is irrevocable. So 0.48.0 is Apache 2.0 from
  its second anniversary; later versions follow on their own dates.
- **Earlier versions keep their licences.** Releases before 0.28.0 stay MIT and
  0.28.0–0.47.x stay PolyForm Noncommercial 1.0.0. They are not relicensed
  here: a grant already made is not revoked, and a licence change that quietly
  rewrote the terms of shipped versions would be a different decision.
- App templates under `templates/` keep their own MIT licences; they are
  copied into users' projects and are not AICO.
- Wording everywhere: **source-available** (the FSL authors call this "Fair
  Source"). Never "open source": FSL is not OSI-approved. Never "MIT" or
  "Apache" for the current version — Apache 2.0 is only the future licence.
  The plain sentence to use: *AICO is source-available under the Functional
  Source License (FSL-1.1-ALv2): free to use, change and run — including inside
  a company — for anything except building a competing product or service; each
  release becomes Apache 2.0 two years after it ships.*
- The 0004 attribution mechanism (`Required Notice:` lines, the credit line for
  forks) is dropped: FSL's Redistribution clause already requires keeping the
  copyright notices and the terms. The commercial-licence route is unchanged
  (a GitHub issue; no personal contact details published).
- Contributions are accepted under the same licence ([CONTRIBUTING.md](../../../CONTRIBUTING.md)).

## Alternatives considered

| Option | Why not |
|---|---|
| Stay on PolyForm Noncommercial | enterprises cannot adopt it, which blocks the organisation product |
| Apache 2.0 / MIT now | anyone, including a cloud vendor, could ship a competing hosted AICO or the same Control product immediately |
| AGPL | OSI-approved but not a defence against a competitor and a deterrent to the companies we want; copyleft obligations on internal use are unclear to buyers |
| Business Source License (BSL) | similar intent, but each project writes its own "additional use grant" and change date — unvetted text; FSL is a fixed, maintained template with a two-year conversion |
| Functional Source License with MIT future licence (FSL-1.1-MIT) | equally valid; Apache 2.0 chosen for its express patent grant |
| Custom licence | unvetted legal text |

## Consequences

- **Good:** any company may use AICO internally today; a competitor cannot
  repackage it; the code becomes permissively licensed on a fixed schedule,
  which is a credible promise for adopters.
- **Costs:** still not open source (some people and distributions will not
  package it); "competing" is a judgement at the edges, and anyone unsure
  should ask; the attribution requirement for forks is weaker than 0004's.
  This ADR is not legal advice — the owner may want a lawyer to review the
  commercial-licence implications before AICO Control is sold.
- **Dependencies:** third-party packages keep their own licences; one must be
  compatible with distribution under FSL-1.1-ALv2 (the permissive allow-list in
  `scripts/security-deps.mjs` is unchanged — it reads dependencies' licences,
  never AICO's own).
- **Copies of 0.28.0–0.47.x already in the wild** remain under PolyForm
  Noncommercial; someone who wants FSL terms must use 0.48.0 or later.

## Verification

`scripts/check-standards.mjs` fails on a package declaring any licence other
than `FSL-1.1-ALv2`, and on current-tense "open source", MIT, Apache or PolyForm
claims in our own Markdown and HTML (history that names "before 0.28.0",
"0.28.0 to 0.47.x" or "at the time", and Apache as the future licence, are
allowed; a deliberate exception carries `standards-allow: licence`).
`scripts/test-check-standards.mjs` proves each case.
