# Changelog

Notable changes to Gateweave Mail, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/mail/releases) carries the same
notes. Publishing a release deploys it.

## [0.1.0] - 2026-11-16

The first release. Mail gives a workspace mailboxes for people and agents on one Cloudflare Worker:
it receives mail and keeps it, and people and agents answer and write from their mailboxes. It is
early: expect breaking changes until 1.0.

### What is in it

- **Accounts and workspaces.** Sign-up, sign-in with a password, through an OpenID Connect provider
  or GitHub, password reset, invitations and roles.
- **Domains and addresses.** A workspace proves a domain with a DNS record and gives its addresses
  to mailboxes. Mail arrives through Cloudflare Email Routing or, with the workspace's own key,
  through Resend.
- **Mailboxes.** Each mailbox keeps its mail in its own Durable Object, with the raw messages sealed
  in R2. People read threads, see whether a sender's domain was proved, open attachments and
  choose whose remote images to load.
- **Sending.** Replies and new mail, formatted and with files, through Cloudflare Email Service or
  Resend, with delivery events, a suppression list and a daily limit per workspace. Mail between
  addresses of the same deployment is delivered directly.
- **Agents.** An agent is a member with a key. It reads and sends through an MCP server at `/mcp`
  and a REST API at `/api/v1`, waits for mail and reads verification codes, and can make addresses
  of its own. What it sends can wait for a person's approval, and an agent can be paused. Its page
  shows what it did.
- **Webhooks and templates.** A workspace's and an agent's webhooks for received and sent mail,
  with sealed signing secrets, and templates an agent can send from.
- **A client library and a plugin.** `@gateweave/mail` for the API, and a Claude Code plugin with a
  skill for the MCP server.

### Running your own

- **Sign-up can be closed.** Set `SIGN_UP_ALLOW` to the addresses and domains that may make an
  account. With it, the sign-up form makes no account, and a new one is made only for a listed or
  invited address that a provider proved. Without it sign-up is open: anyone who can reach the
  address can make an account and a workspace. See "Closing sign-up" in `docs/self-hosting.md`.
  ([#59](https://github.com/gateweavehq/mail/pull/59))
- **Set `SECRETS_KEY` before mail arrives**, and keep a copy: stored mail opens only with it.
- **Durable Objects can be kept in a jurisdiction** with `DURABLE_OBJECT_JURISDICTION`, set before
  the first mailbox is made. ([#60](https://github.com/gateweavehq/mail/pull/60))
- `docs/self-hosting.md` has the whole setup, and the Deploy to Cloudflare button makes the
  database, the bucket and the queue.
