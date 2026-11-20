# Changelog

Notable changes to Gateweave Mail, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org). Until 1.0, any release may change how things work:
read its entry before updating a self-hosted copy.

Each version's [GitHub release](https://github.com/gateweavehq/mail/releases) carries the same
notes. Publishing a release deploys it.

## [0.4.0] - 2026-11-20

An agent whose mail goes out without approval now sends only to addresses it may reach, and
its webhooks only to hosts it may use. This release has two D1 migrations.

### Changed

- **An agent under "Never" sends only to recipients it may reach.** Every To and Cc must be one
  of these:
  - inside the workspace;
  - on the agent's allowed list;
  - the From of mail still kept in a mailbox the agent can read, whether or not DMARC proved
    it, so anyone who writes in can be answered.

  Anything else is refused: no message is made, it uses none of the day's count, and the
  activity page shows the subject and the refused addresses. Mail an agent has read can no longer
  talk it into writing to a stranger. ([#75](https://github.com/gateweavehq/mail/pull/75))
- **An agent's replies go only where they may.** On mail whose sender was proved, a reply
  follows Reply-To. On mail that was not proved, it goes to From, and each Cc must pass the same
  check. A reply to mail the mailbox sent keeps its original To and each distinct Cc.
  ([#75](https://github.com/gateweavehq/mail/pull/75))
- **An agent's webhooks need an allowed host.** Making one, changing its address, resuming it
  and sending a test all need a host on the agent's list. The hosts an agent already uses are
  added to its list the first time its settings are read, so nothing that works today stops.
  ([#75](https://github.com/gateweavehq/mail/pull/75))

### Added

- **"Allow any recipient and webhook host"**, per agent, for owners and admins, beside the
  approval setting. It is off for every agent, new and existing, and each change is logged with
  who made it. ([#75](https://github.com/gateweavehq/mail/pull/75))

### Fixed

- **Plain text made from HTML puts each link's words before its address**, and keeps a link whose
  tag was never closed. This is the text part Mail writes when mail is sent as HTML only.
  ([#74](https://github.com/gateweavehq/mail/pull/74))

### If you run your own

- **Update.** Two D1 migrations (`0027_agent_any_recipient`, `0028_agent_webhook_hosts`), which
  `pnpm run deploy` applies before the new code goes live. Each mailbox upgrades its own storage
  when it is next used.
- **Older mailboxes.** A mailbox that holds mail from before Mail indexed every sender checks
  that mail's sender against the stored original before trusting it. While a check cannot
  finish, a send to that sender answers 503 for up to an hour, then the sender counts as unknown.
- **Agents that wrote to outside addresses** under "Never" before this release are refused from
  now on. Add those addresses to the agent's allowed list, or turn on "Allow any recipient and
  webhook host" for it.

## [0.3.0] - 2026-11-19

Mail an agent sends now says that an AI agent wrote it, for people and for machines.

### Added

- **Agent mail says an AI agent wrote it.** Mail sent with an agent's key, by REST or MCP,
  replies and messages made from templates included, starts with "This message was written by
  an AI agent (agent name)." in the text, and in the HTML as its own paragraph before anything
  the agent wrote. It also carries the header `X-AI-Disclosure: mode=machine-generated`, or
  `mode=ai-originated` when it waited for a person's approval. Approval and sending again keep
  the marks the message was made with. This supports the transparency rules of the EU AI Act,
  Article 50, and cannot be turned off. A person's own mail is unchanged.
  ([#72](https://github.com/gateweavehq/mail/pull/72))

### Changed

- **An agent's HTML is cleaned so it cannot hide that line.** It loses its `<style>` elements
  and `<head>` (keeping the head's text), its `<html>` and `<body>` become plain blocks that
  keep only `lang` and `dir`, and its inline styles keep ordinary formatting: colours, common
  fonts, borders, spacing and table widths. Mail an agent wrote to rely on other styles may look
  plainer. ([#72](https://github.com/gateweavehq/mail/pull/72))

### If you run your own

No migration, variable or secret. Deploy as usual.

## [0.2.2] - 2026-11-19

Better Auth, which runs sign-in, is updated to 1.7.25.

### Changed

- **Better Auth 1.7.25** (from 1.7.20), the version Gateweave ID runs. Among its fixes: a
  sign-in code is no longer left hanging on Workers when an earlier request for it ended
  mid-query, and a session's cookies are cleared when the session is revoked.
  ([#69](https://github.com/gateweavehq/mail/pull/69))

### If you run your own

No migration, variable or secret. Deploy as usual.

## [0.2.1] - 2026-11-19

A security fix: after signing in, Mail could send a person on to another site.

### Fixed

- **The page to return to after signing in could be on another site.** A return path whose dot
  segments resolved to `//example.com` or `/\example.com`, such as `/.//example.com/x`, passed
  the check before resolution and was read by the browser as another site afterwards. Mail now
  refuses such a path; an ordinary `..` that stays on the site still works.
  ([#64](https://github.com/gateweavehq/mail/pull/64))

### Changed

- The icon is redrawn so the envelope's flap sits inside its frame.

### If you run your own

No migration, variable or secret. Deploy as usual.

## [0.2.0] - 2026-11-18

### Changed

- **An agent sends on its own by default.** An agent's policy now says one of three things: it
  sends on its own, it sends on its own to the addresses and domains listed and the rest waits for
  a person, or everything waits. A new agent sends on its own. An owner or admin chooses on the
  agent's page. **Agents made before this release keep what they had**: one with a list keeps its
  list, one without still has everything wait, until a person changes its policy.
  ([#62](https://github.com/gateweavehq/mail/pull/62))
- **Mail inside a workspace does not wait.** A message whose every recipient is a live address of
  the agent's own workspace is delivered whatever the policy says, unless the agent is paused. For
  an agent made before this release this begins when its policy is next saved.
- The agent's page states the brakes that need no person beside the choice: the agent's daily
  limit (20 for a new agent), the workspace's daily limit, the suppression list, an admin's pause
  and the agent's log, which records every message it sent on its own.

### Fixed

- An agent paused or deleted while one of its messages was being sent could still have that
  message go out. The pause and the membership are now read again just before the message is
  handed over.

### Worth knowing

- An agent that sends on its own can be led by a message it reads to write to anyone, up to its
  daily limit. For an agent that reads mail from strangers and should not write freely, choose
  "everything waits" or a list. Neither holds mail to the workspace's own addresses, which goes
  under every policy; only pausing the agent stops that.

### Running your own

- One D1 migration (`0026_agent_policy_approval.sql`, a nullable column), which `pnpm run deploy`
  applies before the new code goes live. No new setting.
- The `send_email`, `reply` and `send_template` operations answer "sent" or "held" as before; the
  skill in the Claude Code plugin says what becomes of a message under each policy.

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
