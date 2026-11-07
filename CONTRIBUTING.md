# Contributing to Gateweave Mail

Thanks for helping out! This guide covers how to get a working setup and what we look for in a
pull request. Everyone taking part is expected to follow our [Code of Conduct](CODE_OF_CONDUCT.md).

## Where to start

Issues labelled [good first issue](https://github.com/gateweavehq/mail/labels/good%20first%20issue)
are small, and each says where to look and when it's done. Say in the issue that you're taking
one, so nobody does it twice, and ask there if you get stuck. If you have something else in
mind, open an issue first for anything large.

## Setup

```sh
pnpm install
pnpm doctor      # checks Node, pnpm and the local setup, with fixes for anything missing
pnpm dev:setup
pnpm dev
```

See the [README](README.md) for details and [docs/architecture.md](docs/architecture.md) for how
the system fits together.

## Contributor License Agreement

Gateweave Mail is open source under the AGPL-3.0. The maintainer also offers it under other terms,
such as a hosted service and commercial licenses, and these help fund the project. So that every
contribution can be part of both, contributors sign the [CLA](CLA.md) once, and it covers every
Gateweave project. You keep the copyright to your work.

A bot asks you to sign on your first pull request. To sign, reply with the sentence it gives you.

## Before you open a pull request

```sh
pnpm verify      # Biome check, typecheck, tests and a production build: what CI runs
```

`pnpm format` fixes most Biome findings. While iterating, scope a command to one package, for
example `pnpm --filter @gateweave/mail-web test`.

Fill in the pull request template: it asks how you tested the change and whether it needs a
migration. You don't need to edit `CHANGELOG.md`; it is written when a
version is released.

## Guidelines

- **Keep changes focused.** One pull request should cover one concern. Open an issue first for
  large features or anything that changes the data model.
- **Test behavior, not implementation.** Worker tests build the app and run it in workerd
  (`apps/web/test`). Add a test for every bug fix.
- **Schema changes need migrations.** Edit the Drizzle schema, then run `pnpm db:generate` in the
  package that owns it. Commit the generated migration. Never edit a migration that has already
  been merged.
- **Match the surrounding code.** Biome enforces formatting. For everything else, follow the
  conventions of the file you are editing.

## Commit messages

We use [Conventional Commits](https://www.conventionalcommits.org): `feat:`, `fix:`, `docs:`,
`refactor:`, `test:`, `chore:`. Add a scope when it helps, for example
`fix(web): keep the workspace menu open on mobile`.

## Working with AI coding agents

You are welcome to use one. [AGENTS.md](AGENTS.md) gives agents the project's commands,
invariants and conventions, and `.claude/skills/` holds step-by-step playbooks for recurring
tasks such as changing a schema or opening a pull request. You remain responsible for the change:
review it, run `pnpm verify`, and make sure you can explain it in review.

## Reporting bugs

Open an issue using the bug report form: the steps to reproduce, what you expected, and what
happened. Report security problems privately, as described in [SECURITY.md](SECURITY.md), never
in a public issue.
