---

name: run-locally
description: Start Gateweave Mail locally (Workers, D1 and Durable Objects via Vite) and check a change in a real browser - sign up, create a workspace, and walk through the pages. Use for UI changes and for confirming a flow end to end.
---

# Run Gateweave Mail locally and check a change

## Start

```sh
pnpm doctor       # toolchain, setup and port check, with fixes
pnpm dev:setup    # first time only: .dev.vars + local D1 migrations
pnpm dev          # http://localhost:4750
```

- Gateweave products use 47xx ports (site 4700, Track 4710, Mail 475x), and
  `pnpm dev` fails instead of moving when 4750 is taken. Check whether a Mail dev server is
  already running and reuse it. Otherwise pick another port in Mail's range:
  `pnpm --filter @gateweave/mail-web exec vite dev --port 4751`. The browser tests use 4752.
- Don't run two dev servers at once. They would share the local state in
  `apps/web/.wrangler/state`.
- Server code reloads on save. After installing a dependency, restart the server.

## Walk through the app

1. Open `/login?mode=sign-up` and create an account with any email and password. Without
   `EMAIL_FROM` in `.dev.vars`, nothing is sent and no verification is needed.
2. Create a workspace on `/`. It opens at `/<slug>` with the sidebar and says there are no
   mailboxes yet.
3. Check the page you changed, then the members page (`/<slug>/settings/members`): inviting
   creates a link to share.

The dev server does not receive mail. To try the `email()` handler, run `pnpm test`: the Worker
test `test/inbound.test.ts` delivers messages to it the way Email Routing does.

## Reset local data

Stop the dev server first. To start over, delete `apps/web/.wrangler/state` (all local users and
workspaces) and run `pnpm dev:setup` again.
