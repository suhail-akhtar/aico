# aico for VS Code

Run the [aico](https://github.com/suhail-akhtar/aico) coding agent inside VS
Code — in a tab of its own in the Secondary Side Bar, beside Chat.

Not a web page in a frame. The panel is drawn natively, styled from your theme's
own colours, and it knows what you have open.

- **Ask about what you are looking at** — the active file, your selection with
  its line range, and that file's Problems arrive as chips above the composer.
  Every chip is removable, so what gets sent is on screen before you send it.
  `#` points at another file or a symbol; `@` addresses a specialist agent.
  `Ctrl+Alt+A` puts the cursor in the composer with the selection attached.
- **Edits land in the editor** — a write is applied as a `WorkspaceEdit`, so
  `Ctrl+Z` takes it back and Source Control shows it. Declining one is a real
  answer: the agent is told, and takes another route.
- **Approve as much or as little as you like** — full auto, auto-accept edits
  (commands and fetches still ask), or ask about everything. Prompts are native
  modals, not cards you can scroll past while a turn waits.
- **See the shape of a run** — the task list, sub-agents it delegated to, a
  proposed plan you can accept or amend, the context meter, and the goal.
- **The editor as a tool** — the agent can read your Problems panel to check its
  own work against the language server, run the tasks you already configured in
  `tasks.json`, and set a new project up to the point of opening it. Opening a
  folder always asks first.
- **Background work in the status bar** — a run started an hour ago, or a
  scheduled job that failed overnight, without opening anything.

The server owns the run, not the panel. Close the window and the work carries
on; reopen it and the conversation replays from its log — the same conversation
you can pick up in a browser tab, where there is room for Mini Apps, the
trajectory view and the full settings screens.

Requires aico on your `PATH` (`aico.command` if not) and Node 22.5+.
