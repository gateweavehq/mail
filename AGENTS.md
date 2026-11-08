# AGENTS.md

Guidance for AI coding agents (and humans) working in this repository. It is the single source
of truth for how the project is built; `CLAUDE.md` and other tool-specific files only add to it.

## The project

Gateweave Mail will be mailboxes for people and AI agents, on Cloudflare, with no server to run. It
is part of [Gateweave](https://gateweave.com), next to
[Gateweave Track](https://github.com/gateweavehq/track),
[Gateweave ID](https://github.com/gateweavehq/id) and
[Gateweave Agents](https://github.com/gateweavehq/agents). Everything ships as one Worker.

It is early. Today it has accounts (sign-up, sign-in, password reset, an account page, sign-in
through an OpenID Connect provider), workspaces with members and invitations, a directory of
proved domains, mailboxes and addresses, and an `email()` handler that refuses an address that
doesn't exist and stores mail for one that does, in a Durable Object per mailbox and R2. Members
read the mailboxes they are given, with formatted mail in a sandboxed frame, and reply to their
mail and write new mail from them in plain text, through Cloudflare Email Service. Agents read theirs
with a key, through the API, and send from the mailboxes that let them: what goes to anyone their
policy doesn't name waits for a person to approve it. Addresses an agent can make for itself,
aliases and transactional sending are planned, not built.

Read [docs/architecture.md](docs/architecture.md) before changing auth or the `email()` handler.

## Repository map

| Path              | What lives there                                                            |
| ----------------- | --------------------------------------------------------------------------- |
| `apps/web`        | The Worker: TanStack Start UI, Better Auth, rate limiting, email, `email()` |
| `docs/`           | Architecture and self-hosting                                               |
| `scripts/`        | Repository tooling (`doctor`, `update-copy`)                                |
| `.claude/skills/` | Step-by-step playbooks for recurring tasks (plain Markdown, any agent)      |
| `wrangler.jsonc`  | The Worker's config, at the root because the Deploy button reads it there   |

There are no `packages/` yet. Add one when a second consumer needs the same code, not before.

Wrangler commands that use the build output (`deploy`, `versions upload`, `preview`) must run
from the repository root, where the build leaves its pointer next to `wrangler.jsonc`. Use
`pnpm wrangler …`, which does that.

## Commands

Requirements: Node.js 24 (see `.node-version`; 22+ works) and pnpm 12. Run from the repository
root unless noted.

| Command           | Purpose                                                                      |
| ----------------- | ---------------------------------------------------------------------------- |
| `pnpm install`    | Install dependencies                                                         |
| `pnpm doctor`     | Check the local toolchain and setup, with fixes for anything missing         |
| `pnpm dev:setup`  | One-time: create `.dev.vars` and migrate the local D1 database               |
| `pnpm dev`        | Run the app on http://localhost:4750 (Workers, D1 and Durable Objects local) |
| `pnpm check`      | Biome lint and format check (`pnpm format` fixes most findings)              |
| `pnpm typecheck`  | Type-check the app (regenerates Wrangler and route types first)              |
| `pnpm test`       | Run every test suite                                                         |
| `pnpm test:e2e`   | Build, then run the browser tests (Playwright, Chromium) on port 4752        |
| `pnpm build`      | Production build                                                             |
| `pnpm verify`     | Everything CI runs: check, typecheck, test, build                            |
| `pnpm run deploy` | Build, apply D1 migrations, deploy                                           |
| `pnpm wrangler`   | The pinned Wrangler, run from the repository root                            |

Gateweave's products use the 47xx ports locally: Mail is 475x (dev 4750, browser tests 4752).

Scope a command to one package with `pnpm --filter <name> <script>`, for example
`pnpm --filter @gateweave/mail-web test`. Run `pnpm verify` before you consider a change done.

## Invariants

These are load-bearing. Breaking one breaks users' data or security, usually silently.

1. **Workspaces are private.** Every server function that reads or changes workspace data checks
   the caller's membership in D1 first (`currentMember` in `apps/web/src/server/access.ts`).
   Non-members get the same "not found" as a missing workspace.
2. **Server code never reaches the browser bundle.** In server functions, import server modules
   dynamically inside the handler, as `apps/web/src/lib/session.ts` does.
3. **One Better Auth instance per isolate, built on first use** (`getAuth()`). workerd forbids
   I/O in global scope, and `test/startup-logs.test.ts` fails if a cold start logs an error.
4. **Admin rights are granted, never assumed.** What only owners and admins may do is decided
   with `isAdminRole` (`apps/web/src/lib/roles.ts`), which names the roles that may. Never compare
   a role with `member`: a role added later would be an admin without anyone granting it.
5. **A workspace keeps an owner**, in the database as well as in the endpoints: two triggers on
   `member` (`apps/web/migrations/0001_owner_triggers.sql`) refuse the change that would leave
   none.
6. **Migrations are append-only.** Generate them with Drizzle Kit and commit them. Never edit a
   migration that has been merged. Follow `.claude/skills/schema-change/SKILL.md`.
7. **Secrets stay local.** Never commit `.dev.vars` or print its contents.
8. **The `email()` handler has about 2 seconds of CPU**, measured on 2026-11-07, and
   `limits.cpu_ms` does not change that. It looks up and refuses, or stores: it reads the header
   block and streams the rest to R2. Parsing a message happens when someone opens it.
9. **Delivery is at least once.** A slow handler is cancelled after about 5 minutes and run
   again, and a sender retries after a temporary refusal. Handling the same mail twice must
   change nothing.
10. **On an internal failure, let the handler throw.** That tells the sender to try again (`421`).
    `message.setReject` is permanent (`555`): use it only for a real refusal, such as an address
    that does not exist, never for our own trouble.
11. **Mail is untrusted input.** Only `dmarc=pass` in Cloudflare's own `Authentication-Results`,
    among the headers it adds at the top, is proof of who sent a message, and only of the domain
    it checked (`header.from`), when that is the domain of the one address in the one `From`
    (`verifiedDomain`). For mail that came through Resend, only the DMARC result its API gives is
    (`resendVerifiedDomain`), never a header in that mail, which could copy Cloudflare's. A forged message can arrive marked `dmarc=none`, bring an
    `Authentication-Results` of its own, or put an address in the name before the real one, so
    show the proved domain, never a mark alone. `message.from` is the envelope sender, not the
    person the reader will see, so show the `From` header. Show a message's HTML only as the page
    `messageHtml` serves, under its own policy (`framePolicy`: a sandbox without scripts or the
    app's origin, nothing from elsewhere but images the reader asked for), and only in a frame with
    the same sandbox; never in one of the app's pages. Serve the original only as a download.
12. **A mailbox's Durable Object has no public route.** Only `email()` and Resend's webhook, after
    looking the address up, and server code, after checking membership and that the mailbox is in the caller's
    workspace, reach it. Mail is read only through `openMailbox`
    (`apps/web/src/server/mailbox/read.ts`), which applies `canReadMailbox`: being in the workspace
    is not enough. Every R2 object is named by the mailbox's object, as pending, before it is
    written, so R2 never holds mail a mailbox doesn't know about.
13. **A key is an agent's: it reads, and sends only as it was let.** A request with a bearer
    token is decided by its key alone (`currentCaller` in `apps/web/src/server/access.ts`), never
    by the cookies that come with it. Reading takes `currentCaller`, and so does the outbox, where
    a key may only send, from a mailbox whose grant lets it (`mailbox_access.send`), within its
    policy (`agent_policy`): mail to anyone the policy doesn't name is `held` until a person
    approves it. Only people approve, reject, send again or discard. Whatever else changes
    something takes `currentMember`, a person signed in. Keep only a key's hash, and never log a
    key.
14. **A message that may have gone is never sent again by itself.** Email Service has no
    idempotency key, so a send that failed without a code, with its own failure, or that nothing
    finished, is `uncertain`, and only a person's "Send again" sends it again. Through Resend, the
    one exception, every try of a message carries its `outgoing.idempotency_key`, which Resend
    keeps for a day, so the alarm may try it again. Change that key only after Resend has refused
    it and no earlier try under it may have gone (`outgoing.maybe_sent`), and after such a try,
    never end it as `refused` or send it through another saving of the key
    (`outgoing.key_version`): Resend checks a key before the message, and knows an idempotency
    key only in its own account. A draft's id makes a second send of it the first. The copy and its `outgoing` row are
    written in one transaction before anything is called, each change of state is made only from
    the state it was found in, and the message's own id goes in its `References`, so its thread
    doesn't depend on the `Message-ID` the provider gives it.
15. **A workspace's provider key never leaves the server.** It is sealed with `SECRETS_KEY` and the
    workspace's id (`apps/web/src/server/secrets.ts`) before it is written, opened only to send or
    to check it with Resend, and pages see only its last four characters. Never log it, return it
    or put it in an error. Putting one in takes an owner or admin with a recent sign-in.
16. **Resend's webhook admits only what the workspace's secret signed.** A delivery to
    `/api/inbound/resend/<channel>` carries no session: the channel finds the workspace, and the
    Svix signature, under the webhook's signing secret sealed in `resend_inbound`, within five
    minutes, proves Resend sent it (`apps/web/src/server/resend-inbound.ts`). The webhook's body
    names an email and nothing more is taken from it: who the mail is for, Resend's DMARC result
    and the raw mail come from Resend's API with the workspace's key. Mail is stored only for that
    workspace's addresses on proved domains set to receive with Resend, and only for the envelope's
    recipient, which Resend names in the email's `to`: never for an address that is only in its
    headers (`cc`, `received_for`), which the sender writes. Answer with a success only
    once it is stored, or when trying again can't help; otherwise answer 503, and Resend tries
    again for about a day.

## Code style

- TypeScript is strict, with `noUncheckedIndexedAccess`. Avoid `any` and non-null assertions.
- Biome formats: tabs, 100 columns, double quotes. Don't hand-format; run `pnpm format`.
- Validate untrusted input at the boundary with zod. Inside, trust the types.
- Prefer `#private` fields, named exports and small modules. Default exports only where a
  framework requires them.
- Comments explain why, not what. Match the tone and density of the file you are editing.
- Generated files are not edited by hand: `routeTree.gen.ts`, `worker-configuration.d.ts`,
  `apps/web/src/server/db/auth-schema.ts` (`pnpm --filter @gateweave/mail-web auth:schema`), and
  everything under `apps/web/migrations/` except custom migrations
  (`drizzle-kit generate --custom`, such as `0001_owner_triggers.sql`).
- Dependencies are pinned to exact versions. Shared ones go in the `catalog:` of
  `pnpm-workspace.yaml`. `drizzle-orm` stays on 0.45: the 1.0 migration format does not work
  with Wrangler's D1 migrations.
- UI code copied into the repository (components, blocks, hooks) must come from an MIT or
  Apache-2.0 source, such as shadcn/ui, Magic UI or SmoothUI. Note the source and keep its
  copyright notice in a comment at the top of the file. Paid or restricted kits (Aceternity UI,
  shadcn.io blocks, shadcnstudio Pro) cannot ship in an AGPL repository.

## Code shared with the other Gateweave products

Auth, rate limiting, email, the Worker test harness and the UI primitives came from
[gateweavehq/agents](https://github.com/gateweavehq/agents), which took them from
[gateweavehq/track](https://github.com/gateweavehq/track), and are owned here now, the way
shadcn/ui components are. When you fix a bug in one of them, check whether the others have the
same bug, especially in auth and rate limiting. They become shared packages only when it is worth
the cost.

## Testing

- Test behavior through public APIs, not internals.
- `apps/web` has unit tests in `src/` and Worker tests in `test/`. The Worker tests build the app
  and run it in workerd through Miniflare, with every outbound request failing as a deployed
  Worker's request to its own hostname does; see `test/mail-worker.ts`. That harness also
  delivers a message to the Worker's `email()` handler (`deliver`), the way Email Routing does.
- `apps/web/e2e` has browser tests: Playwright drives Chromium against the production build
  (`vite preview`, port 4752, its own empty local database). They cover what the other suites
  cannot: sign-up, the account page, and a page a policy breaks (`e2e/fixtures.ts` fails a test on
  any refusal). `pnpm test:e2e` builds and runs them; the first time, run
  `pnpm --filter @gateweave/mail-web exec playwright install chromium`. They are not part of
  `pnpm verify`; CI runs them as the `e2e` job. Every test signs up its own user and workspace.
  To run them in two checkouts at once, give each its own port with `MAIL_E2E_PORT`.
- Every bug fix gets a test that fails without the fix. Never weaken or skip a test to make a
  change pass.

## Git and pull requests

- `main` is protected: changes land through pull requests with a green `check`, squash or rebase
  merged. Branch from `main` as `feat/…`, `fix/…`, `docs/…` or `chore/…`.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org), with a
  scope when it helps: `fix(web): keep the workspace menu open on mobile`. Explain why in the
  body.
- Commits, pull requests, comments and release notes carry no AI attribution: no
  `Co-authored-by` trailer naming an AI, no "Generated with" line and no session link. If your
  tool adds them, take them out before you push, and out of the message of a squash merge,
  which GitHub fills from the commits. History already merged stays as it is.
- Fill in the pull request template. A CLA bot asks first-time contributors to sign once.
- Follow `.claude/skills/open-pull-request/SKILL.md` for the full flow.
- Pull requests leave `CHANGELOG.md` alone, so parallel branches do not conflict there. A
  maintainer adds each version's entry when releasing.

## Playbooks

Each folder in `.claude/skills/` holds a `SKILL.md` for a recurring task. They are plain Markdown,
so any agent can follow them:

| Skill               | Use it to                                                  |
| ------------------- | ---------------------------------------------------------- |
| `schema-change`     | Change the D1 schema with a migration                      |
| `run-locally`       | Start the app and check a change in a real browser         |
| `open-pull-request` | Take a change from a branch to a merged-ready pull request |
