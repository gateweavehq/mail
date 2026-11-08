<p align="center">
  <img src=".github/logo.svg" width="96" height="96" alt="">
</p>

<h1 align="center">Gateweave Mail</h1>

<p align="center">
  <strong>Mailboxes for people and agents, on one Cloudflare Worker.</strong><br>
  Open source, with no server to run. Early: it receives and keeps mail, and people reply and
  write from their mailboxes in plain text.
</p>

<p align="center">
  <a href="https://github.com/gateweavehq/mail/actions/workflows/ci.yml?query=branch%3Amain"><img src="https://github.com/gateweavehq/mail/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI status"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/gateweavehq/mail" alt="License: AGPL-3.0"></a>
</p>

<p align="center">
  <a href="https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/mail"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>
</p>

Gateweave Mail is part of [Gateweave](https://gateweave.com), the family of open-source business
tools that run on Cloudflare, next to [Gateweave Track](https://github.com/gateweavehq/track),
[Gateweave ID](https://github.com/gateweavehq/id) and
[Gateweave Agents](https://github.com/gateweavehq/agents).

> **Status: early development.** Mail receives and keeps mail, and sends plain text. What exists
> is sign-in, workspaces, a directory of domains and addresses, and mailboxes whose messages the
> people given them read and answer. Expect breaking changes until 1.0; see
> [CHANGELOG.md](CHANGELOG.md).

## What works today

- **Accounts.** Sign-up, sign-in, password reset (with email set up), sign-out, deleting your
  account and an account page, with limits on password tries and on account changes.
- **Sign-in through a provider.** "Continue with Gateweave", or any OpenID Connect provider you
  configure, and optionally GitHub. Each is off until configured.
- **Workspaces.** Create one, invite people by link or email, and give them roles (owner, admin
  or member).
- **Domains, mailboxes and addresses.** Prove a domain with a DNS record, make mailboxes, and give
  them addresses, for good or for a set number of days. Owners and admins read every mailbox and
  choose who else reads each one: everyone in the workspace, or the people they pick.
- **Receiving mail.** The Worker's `email()` handler looks up each message's address and refuses
  one that doesn't exist. Mail for one that does is kept in its mailbox, once even when it arrives
  twice, up to 1 GiB per mailbox.
- **Reading mail.** Whoever may read a mailbox sees its threads, newest news first, and reads
  their messages, with the attachments listed and the original to download. HTML mail shows in a
  sandbox that runs nothing and loads remote images only when asked. Replies join
  the thread of the message they answer, or of other replies to it, when their subject matches.
  A sender's domain shows as proved only when the message passed DMARC for it. Owners and admins
  can delete a message.
- **Search.** Find a mailbox's threads by the words in their messages: subject, sender, text and
  attachment names.
- **Replying and writing.** Whoever reads a mailbox replies to its mail and writes new mail from
  its addresses, in plain text, through Cloudflare Email Service. The copy shows in its thread at
  once, with who wrote it and whether it went; one that wasn't sent can be sent again or
  discarded, and one that may have gone is never sent twice by itself.
- **Agents.** An admin makes an agent for an AI agent and gives it a key. It reads, through the
  API, only the mailboxes it is given; opening a mailbox to everyone doesn't open it to agents.
  A mailbox can let an agent send too. Mail to the addresses and domains its settings name goes
  on its own; the rest waits for someone who reads the mailbox to approve or reject it. Each
  agent has a daily limit of its own.

## What it is planned to become

None of this exists yet; it is the direction, and it may change.

- Agents that act on mail as well as read and send it, such as filing or labelling it.
- Formatting, attachments, forwarding and replying to all when writing.
- Addresses an agent can make for itself.
- Aliases that point at a mailbox.
- Transactional sending and templates, through Cloudflare Email Service.

The planned shape is in [docs/architecture.md](docs/architecture.md).

## Tech stack

[TanStack Start](https://tanstack.com/start) · React 19 · Tailwind CSS 4 ·
[Better Auth](https://better-auth.com) · [Drizzle ORM](https://orm.drizzle.team) ·
Cloudflare Workers, Durable Objects, D1 and R2 · TypeScript 7 · Vitest · Biome

## Getting started

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
pnpm install
pnpm doctor      # checks your toolchain and setup, and explains how to fix anything missing
pnpm dev:setup   # creates .dev.vars with a random secret, migrates the local database
pnpm dev         # http://localhost:4750
```

Sign up with any email and password, then create a workspace. To enable "Sign in with GitHub" or
a provider such as Gateweave ID, uncomment and fill in its keys in `.dev.vars`.

## Scripts

| Command          | What it does                                             |
| ---------------- | -------------------------------------------------------- |
| `pnpm dev`       | Run the app locally with Workers, D1 and Durable Objects |
| `pnpm doctor`    | Check the local toolchain and setup                      |
| `pnpm check`     | Lint and format check (Biome)                            |
| `pnpm format`    | Apply formatting and safe lint fixes                     |
| `pnpm typecheck` | Type-check the app                                       |
| `pnpm test`      | Run the test suites                                      |
| `pnpm test:e2e`  | Build, then run the browser tests (Playwright)           |
| `pnpm build`     | Production build                                         |
| `pnpm verify`    | Everything CI runs: check, typecheck, test and build     |

## Self-hosting

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/mail)

The button copies Mail to your GitHub or GitLab account, creates the database, and deploys it to
your Cloudflare account; every push to your copy deploys again. From the command line:

```sh
pnpm wrangler login
pnpm run deploy    # builds, applies D1 migrations, deploys
```

You need a Cloudflare account with the Workers Paid plan: a password sign-in takes more CPU than
the Free plan gives a request, and Email Sending needs Paid as well. When mail ships it will also
need a domain of its own, or that domain's catch-all. [docs/self-hosting.md](docs/self-hosting.md)
covers both ways, your own domain, sign-in providers, email and updating.

## Project structure

```
apps/web               The Worker: UI, auth, the email() handler, D1 schema
docs/                  Architecture and self-hosting
scripts/               Repository tooling
wrangler.jsonc         The Worker's Cloudflare configuration, at the root for the Deploy button
```

Read [docs/architecture.md](docs/architecture.md) for how it is built, and
[CHANGELOG.md](CHANGELOG.md) for what each release changed.

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) and our
[Code of Conduct](CODE_OF_CONDUCT.md). If you work with an AI coding agent, point it at
[AGENTS.md](AGENTS.md). Report security issues privately, as described in
[SECURITY.md](SECURITY.md).

## License

Copyright © 2026 Yiğit Tanrıverdi.

Gateweave Mail is licensed under the [GNU Affero General Public License v3.0](LICENSE). You can
self-host, use and modify Mail freely. If you run a modified version as a network service, you must
make your changes available to its users under the same license.

Contributions are accepted under the [Contributor License Agreement](CLA.md).
