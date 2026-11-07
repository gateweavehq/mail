## What and why

<!-- What does this change, and why is it needed? Link the issue it closes: "Closes #123". -->

## How it was tested

<!-- Commands you ran and what you checked by hand. Screenshots help for UI changes. -->

- [ ] `pnpm verify` passes
- [ ] Tests cover the change (every bug fix has a test that fails without it)

## Deploy notes

<!-- Delete what does not apply. -->

- [ ] Adds a D1 migration (`pnpm run deploy` applies it before the new code goes live)
- [ ] Adds a Durable Object migration (the `migrations` list in `wrangler.jsonc`)
- [ ] Adds an environment variable or secret (in `.dev.vars.example` and `docs/self-hosting.md`)
