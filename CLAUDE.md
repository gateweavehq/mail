@AGENTS.md

## Claude Code

- The playbooks in `.claude/skills/` are project skills: invoke them by name when a task matches.
- Look up current library APIs before relying on memory. The stack moves fast (TypeScript 7,
  Vite 8, Wrangler 4, Better Auth, TanStack Start).
- Before reporting a change as done, run `pnpm verify`, or at least the affected package's
  `typecheck` and `test`. Report failures as they are.
- For UI changes, also check the result in a browser (`run-locally`).
