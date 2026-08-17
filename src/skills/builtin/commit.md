---
name: commit
description: Generate a conventional commit message from staged changes
author: aico
version: 1.0.0
aliases: [cm]
---
Review the staged changes with `git diff --staged` and generate a conventional commit message.

Commit message format: `<type>(<scope>): <short description>`

Types: feat, fix, docs, style, refactor, perf, test, chore, ci, build

Rules:
- Subject line ≤ 72 characters, lowercase, no trailing period
- If there are multiple distinct changes, use a short bullet body
- If nothing is staged, say so and suggest `git add <files>`
- Do NOT commit — only generate and display the message

User args (optional context): {args}

Steps:
1. Run `git diff --staged` to see what's staged
2. If nothing staged, run `git status` and advise the user
3. Summarize the change as a conventional commit message
4. Show the full commit command the user can run
