# Security policy

## Supported versions

Gateweave Mail is in early development. Security fixes go into `main` and the latest release only.

## Reporting a vulnerability

Please report vulnerabilities privately, never in a public issue or pull request.

- Preferred: [open a private security advisory](https://github.com/gateweavehq/mail/security/advisories/new)
  on GitHub.
- Or email **security@gateweave.com**.

Include what an attacker could do, the steps to reproduce it, and the affected version or commit.
We aim to reply within three working days, and will keep you updated while we work on a fix,
and credit you in the release notes unless you would rather stay anonymous.

## Scope

Areas where reports are especially valuable:

- Access to a workspace's data without membership: through its pages and server functions.
- Authentication and session handling, including sign-in through a provider, password reset, and
  the limits on password tries and account changes.
- Anything that lets one workspace member act with another member's identity or role, or become
  an owner or admin without being made one.
- Secrets (`BETTER_AUTH_SECRET`, a provider's client secret) reaching a page, a log or a response.
- Incoming mail: a message accepted or stored that should have been refused, a sender shown as
  someone it is not, or a way to make the `email()` handler fail for other people's mail. Mailboxes
  do not exist yet, so for now the handler refuses everything.
