---
name: init
description: Deep-scan the project and create a comprehensive AICO.md memory file
author: aico
version: 2.0.0
aliases: [setup]
---
Create a comprehensive AICO.md project memory file — the equivalent of Claude Code's CLAUDE.md.
This file is your persistent understanding of the project. Scan DEEPLY before writing.

User args (optional project description): {args}

## Phase 1: Deep Project Scan

Do ALL of these before writing anything:

1. **Project identity**: Read package.json / pyproject.toml / go.mod / Cargo.toml / pom.xml. Identify language, framework, build tool, key dependencies.

2. **Directory structure**: Run `LS` on the root, then `LS` on each major subdirectory (src/, lib/, app/, test/, docs/, config/). Map the full tree.

3. **Entry points**: Find the main entry file (index.ts, main.py, server.js, main.go). Read it to understand startup flow.

4. **Key source files**: Read 3-5 of the most important source files (not all — the largest or most central ones). Understand the architecture.

5. **Build & test**: Find how to build (`npm run build`, `cargo build`, `go build`), test (`npm test`, `pytest`, `go test`), lint (`npm run lint`, `ruff`). Read the scripts section of package.json or equivalent.

6. **Git history**: Run `git log --oneline -10` to understand recent work direction.

7. **Configuration**: Check for .env.example, docker-compose.yml, Dockerfile, CI configs (.github/workflows/), config files. Note what's configured.

8. **Existing documentation**: Read README.md if it exists. Check for existing CLAUDE.md or AICO.md.

9. **Conventions**: Scan 2-3 source files for naming conventions (camelCase vs snake_case), file naming, directory organization patterns, error handling style, test style.

## Phase 2: Generate AICO.md

Write a COMPREHENSIVE AICO.md with these sections:

```markdown
# AICO.md — [Project Name]

## Project Overview
[What this project does, who it's for, what problem it solves. 2-3 sentences.]

## Tech Stack
- Language: [e.g., TypeScript]
- Framework: [e.g., Express, React, FastAPI]
- Database: [e.g., SQLite, PostgreSQL]
- Key Dependencies: [list the 5-10 most important packages]

## Architecture
[Describe the high-level architecture: layers, data flow, key modules.]
[Example: "Express server → route handlers → service layer → repository → SQLite"]

### Key Directories
- `src/` — [what's in it]
- `src/api/` — [what's in it]
- `test/` — [what's in it]

### Entry Point
[Which file starts everything, what it does]

## Development Commands
- Install: `npm install`
- Run: `npm start` or `node server.js`
- Test: `npm test`
- Build: `npm run build`
- Lint: `npm run lint` (if exists)

## Coding Conventions
- Naming: [camelCase / snake_case / etc.]
- File organization: [one class per file? feature-based? layer-based?]
- Error handling: [try/catch? Result types? centralized handler?]
- Testing: [framework, style — unit vs integration, where tests live]
- Style: [any linting rules, formatting config]

## Important Notes
[Anything the AI assistant MUST know: gotchas, constraints, deployment quirks, env vars needed, common mistakes to avoid.]
```

## Phase 3: Write and Confirm

3. If AICO.md already exists, READ it first and MERGE your findings — don't overwrite useful content. Add or update sections.
4. Write the file to `./AICO.md`.
5. Show a preview of what you wrote. Confirm it accurately reflects the project.

Additional context from user: {args}
