# MCP and HTTP reference

Gateweave Mail gives an agent the same operations two ways: as tools on an MCP server, and as
routes of a REST API. Both admit only an agent's key, never a person's session, and both are made
from one list of operations (`apps/web/src/server/agent-api/operations.ts`), so a tool, its route
and the OpenAPI document say the same thing. This page is the reference. For how an agent should
use them, read the skill,
[`plugins/gateweave-mail/skills/mail/SKILL.md`](../plugins/gateweave-mail/skills/mail/SKILL.md).

## How to connect

|                 | MCP server                       | API base URL                        |
| --------------- | -------------------------------- | ----------------------------------- |
| Gateweave Cloud | `https://mail.gateweave.com/mcp` | `https://mail.gateweave.com/api/v1` |
| Your own Mail   | `https://mail.example.com/mcp`   | `https://mail.example.com/api/v1`   |

For a copy you host yourself, use the address of your Worker in place of `mail.example.com`.

An admin makes an agent under Settings → Agents in a workspace and copies its key, which is shown
once. The agent sends it as a bearer token on every request, to `/mcp` and to `/api/v1` alike:

```
Authorization: Bearer <key>
```

A key of a paused agent does nothing: both answer 403. An agent reads only the mailboxes it was
given, and sends only from the ones that let it.

### Claude Code

Mail's plugin adds the MCP server and the skill, and Claude Code keeps the key with its own
sign-in rather than in its settings. This is the way the [README](../README.md#connect-an-agent)
recommends:

```sh
claude plugin install gateweave-mail --marketplace gateweavehq/mail --config mcp_url=https://mail.example.com/mcp
```

Then run `/plugin configure gateweave-mail@gateweave-mail` in Claude Code and paste the key.

To add only the MCP server, without the plugin, run `claude mcp add`. It keeps the key in Claude
Code's settings:

```sh
claude mcp add --transport http gateweave-mail https://mail.example.com/mcp \
  --header "Authorization: Bearer <key>"
```

### Any other MCP client

Point it at the MCP address with the `Authorization` header. As a JSON config, which is the shape
of the plugin's own `.mcp.json`:

```json
{
	"mcpServers": {
		"mail": {
			"type": "http",
			"url": "https://mail.example.com/mcp",
			"headers": {
				"Authorization": "Bearer <key>"
			}
		}
	}
}
```

Coding agents set up through [Gateweave Agents](https://github.com/gateweavehq/agents) read the key
from the `GATEWEAVE_MAIL_KEY` environment variable, so it is never in a repository.

## Tools

One row for each operation. The table is made from `OPERATIONS`, never typed by hand: do not edit
it here. After a change to an operation, or to what an operation needs in
`apps/web/src/server/agent-api/tools-table.ts`, run

```sh
pnpm --filter @gateweave/mail-web exec vitest run --project unit src/server/agent-api/mcp-docs -u
```

to write it again. `?` marks an optional input or output. The HTTP column gives each route under
the API base URL.

<!-- mcp-tools:start -->

| Tool                    | What it does                                                                                                                                                                                                                                                | Input                                                                                                | Output                                                                                   | HTTP                                                                                                                         | What it needs                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `list_mailboxes`        | Lists the mailboxes you may read, with their addresses and whether you may send from each, and your limits: how many messages you may write a day, whether your mail goes on its own or waits for a person to approve it, and which addresses you may make. | none                                                                                                 | `mailboxes`, `sending`, `addressPolicy`                                                  | `GET /api/v1/mailboxes`                                                                                                      | Mailboxes: lists only the ones it was given                                          |
| `search_email`          | Lists a mailbox's threads, the newest news first, or with a query those with a message that has every word of it.                                                                                                                                           | `mailbox`, `query?`, `cursor?`                                                                       | `threads`, `next`, `untrusted`                                                           | `GET /api/v1/mailboxes/{mailbox}/threads`                                                                                    | Mailboxes: a grant to read the mailbox                                               |
| `read_email`            | Reads one message, by messageId, or a thread, by threadId: its messages, newest last, with the newest opened.                                                                                                                                               | `mailbox`, `messageId?`, `threadId?`, `cursor?`                                                      | `message?`, `thread?`                                                                    | `GET /api/v1/mailboxes/{mailbox}/messages/{messageId}`<br>`GET /api/v1/mailboxes/{mailbox}/threads/{threadId}` (read_thread) | Mailboxes: a grant to read the mailbox                                               |
| `get_attachment`        | Gives one file attached to a message, by its place in read_email's attachments, counted from 0: its name, type and bytes in Base64, as send_email and reply take a file.                                                                                    | `mailbox`, `messageId`, `index`                                                                      | `filename`, `contentType`, `size`, `content`, `untrusted`                                | `GET /api/v1/mailboxes/{mailbox}/messages/{messageId}/attachments/{index}`                                                   | Mailboxes: a grant to read the mailbox                                               |
| `wait_for_email`        | Waits for mail to come to a mailbox, such as a confirmation after you signed up somewhere, and opens the newest that matches.                                                                                                                               | `mailbox?`, `to?`, `from?`, `subject?`, `provedOnly?`, `since?`, `timeoutSeconds?`                   | `found`, `message?`                                                                      | `GET /api/v1/wait`                                                                                                           | Mailboxes: a grant to read the mailbox                                               |
| `get_verification_code` | Waits for a sign-up, sign-in or confirmation message from a sender you name, as wait_for_email does, and gives only the one-time code in it, never the rest of its text.                                                                                    | `mailbox?`, `to?`, `from`, `subject?`, `provedOnly?`, `since?`, `timeoutSeconds?`                    | `found`, `code?`, `messageId?`, `fromDomain?`, `verifiedDomain?`, `dmarc?`, `arrivedAt?` | `GET /api/v1/verification-code`                                                                                              | Mailboxes: a grant to read the mailbox                                               |
| `send_email`            | Sends a message from a mailbox you may send from: text or HTML, with files if you like.                                                                                                                                                                     | `mailbox`, `to`, `cc?`, `subject`, `text?`, `html?`, `attachments?`, `from?`, `draftId?`, `context?` | `id`, `threadId`, `state`                                                                | `POST /api/v1/mailboxes/{mailbox}/messages`                                                                                  | Sending: a grant to send from the mailbox, within its daily limit and approval       |
| `list_templates`        | Lists the workspace's message templates: each one's name, the variables to give a value for, its latest version and its subject.                                                                                                                            | none                                                                                                 | `templates`                                                                              | `GET /api/v1/templates`                                                                                                      | Nothing beyond a working key                                                         |
| `send_template`         | Sends a message made from one of the workspace's templates, from a mailbox you may send from, with a value for each of its variables.                                                                                                                       | `mailbox`, `template`, `version?`, `values`, `to`, `cc?`, `draftId?`, `context?`                     | `id`, `threadId`, `state`, `template`, `version`                                         | `POST /api/v1/mailboxes/{mailbox}/template-messages`                                                                         | Sending: a grant to send from the mailbox, within its daily limit and approval       |
| `reply`                 | Answers a message in its thread, from the address it came to.                                                                                                                                                                                               | `mailbox`, `messageId`, `text?`, `html?`, `attachments?`, `draftId?`, `context?`                     | `id`, `threadId`, `state`                                                                | `POST /api/v1/mailboxes/{mailbox}/messages/{messageId}/reply`                                                                | Sending: a grant to send from the mailbox, within its daily limit and approval       |
| `list_addresses`        | Lists the live addresses you made in a mailbox, and how many you have in all.                                                                                                                                                                               | `mailbox`                                                                                            | `addresses`, `live`                                                                      | `GET /api/v1/mailboxes/{mailbox}/addresses`                                                                                  | Addresses: only the ones it made                                                     |
| `create_address`        | Makes an address of your own for a mailbox you may send from, on a domain your policy names, such as one to sign up somewhere with.                                                                                                                         | `mailbox`, `domain`, `localPart?`, `days?`                                                           | `id`, `address`, `expiresAt`                                                             | `POST /api/v1/mailboxes/{mailbox}/addresses`                                                                                 | Addresses: a grant to send from the mailbox, and an address policy naming the domain |
| `end_address`           | Ends an address you made, at once: mail to it is refused from then on.                                                                                                                                                                                      | `mailbox`, `addressId`                                                                               | `ended`                                                                                  | `DELETE /api/v1/mailboxes/{mailbox}/addresses/{addressId}`                                                                   | Addresses: only one it made                                                          |
| `list_webhooks`         | Lists the webhooks you made, with each one's latest deliveries and how they went.                                                                                                                                                                           | none                                                                                                 | `webhooks`, `max`                                                                        | `GET /api/v1/webhooks`                                                                                                       | Webhooks: only the ones it made                                                      |
| `create_webhook`        | Makes a webhook of your own, so you hear of mail without waiting for it: Mail posts each event you choose, of mailboxes you may read, to your https URL, and tries again for about a day while it fails.                                                    | `url`, `events`, `mailboxes?`                                                                        | `webhook`, `secret`                                                                      | `POST /api/v1/webhooks`                                                                                                      | Webhooks: an allowed host, and a grant to read each mailbox it hears of              |
| `update_webhook`        | Changes a webhook of yours: where it goes, what it hears of, or whether it is active.                                                                                                                                                                       | `webhookId`, `url?`, `events?`, `mailboxes?`, `active?`, `newSecret?`                                | `webhook`, `secret?`                                                                     | `PATCH /api/v1/webhooks/{webhookId}`                                                                                         | Webhooks: one it made, and an allowed host for a new URL                             |
| `delete_webhook`        | Deletes a webhook of yours, and what it had yet to deliver.                                                                                                                                                                                                 | `webhookId`                                                                                          | `deleted`                                                                                | `DELETE /api/v1/webhooks/{webhookId}`                                                                                        | Webhooks: only one it made                                                           |
| `test_webhook`          | Has a webhook of yours post a webhook.test event, whatever it listens to, to check that your receiver gets it and checks its signature.                                                                                                                     | `webhookId`                                                                                          | `queued`                                                                                 | `POST /api/v1/webhooks/{webhookId}/test`                                                                                     | Webhooks: one it made, and an allowed host                                           |

<!-- mcp-tools:end -->

What a tool gives from a message is marked as the sender's words, beside the domain that was
proved; read the skill before acting on any of it.

## HTTP notes

- Each route takes its inputs from its path, then from its query string for a `GET` or `DELETE`,
  or from its JSON body for a `POST` or `PATCH`. The body is 1 MB at most, or 16 MB for
  `send_email` and `reply`, whose files come in it.
- A route answers what its tool would, or `{ "error": "…" }` with 400, 401, 403, 404, 409, 413 or
  429, with `Retry-After` when it is known. A failure of Mail's own is a 500 over REST and a tool
  error over MCP, in the same words.
- Any site may call the API (CORS without credentials), as only a key counts and a browser sends
  none of its own.
- `read_thread` is an HTTP route with no MCP tool of its own: `GET
  /api/v1/mailboxes/{mailbox}/threads/{threadId}`. Over MCP, `read_email` with a `threadId` reads
  a thread.
- The API is described by an OpenAPI document, which every Mail serves at `/api/v1/openapi.json`
  (for example `https://mail.example.com/api/v1/openapi.json`). The repository keeps a snapshot of it
  for `https://mail.example.com` as
  [`packages/mail/openapi.json`](../packages/mail/openapi.json), which the TypeScript client,
  [`@gateweave/mail`](../packages/mail), is made from.
