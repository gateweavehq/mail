# @gateweave/mail

A TypeScript client and a command line for the agent API of
[Gateweave Mail](https://github.com/gateweavehq/mail): what an AI agent can do with its key. Read
and search the mailboxes it was given, wait for mail and sign-in codes, send and reply, make
addresses of its own, and hear of mail through webhooks of its own.

- **The SDK** has a method for each route of the API, typed from its OpenAPI document, and a check
  of a webhook delivery's signature. It runs wherever `fetch` and Web Crypto do: Node 22 and later,
  browsers and Cloudflare Workers. It has no dependencies.
- **The command line**, `gateweave-mail`, does what a script or a CI job needs: wait for a
  verification code and print it, wait for a message, send one, check a webhook's signature, or
  call any route.

It will install with `npm install @gateweave/mail`, but it is not on npm yet. Until it is, use it
from this repository: `pnpm --filter @gateweave/mail build` writes `dist/`.

You need your Mail's address, such as `https://mail.example.com`, and an agent's key. An owner or
admin makes the agent in the workspace's settings, under Agents, and copies its key, which is shown
once. The agent sees only the mailboxes it was given, and sends only as its policy lets it: mail to
anyone the policy doesn't name waits for a person to approve it.

## The SDK

```ts
import { MailClient, MailError } from "@gateweave/mail";

const mail = new MailClient({
	url: "https://mail.example.com",
	key: process.env.GATEWEAVE_MAIL_KEY ?? "",
});

const { mailboxes, sending } = await mail.listMailboxes();

// Take the time before you set off the mail, so that an older code isn't taken.
const since = new Date().toISOString();
await signUpWith("signups@acme.example");
const answer = await mail.getVerificationCode({
	to: "signups@acme.example",
	from: "github.com",
	since,
});
if (answer.found && answer.code) console.log(answer.code);

const sent = await mail.sendEmail({
	mailbox: "Sign-ups",
	to: ["someone@example.org"],
	subject: "Hello",
	text: "Hi there.",
	draftId: crypto.randomUUID(),
});
if (sent.state === "held") console.log("It waits for a person to approve it.");
```

Each route of the API is a method, named for its operationId in camelCase, which takes the route's
inputs in one object (its path's, its query string's and its body's, as its MCP tool takes them)
and gives its answer:

| Method                | Route                                                               |
| --------------------- | ------------------------------------------------------------------- |
| `listMailboxes`       | `GET /mailboxes`                                                    |
| `searchEmail`         | `GET /mailboxes/{mailbox}/threads`                                  |
| `readEmail`           | `GET /mailboxes/{mailbox}/messages/{messageId}`                     |
| `readThread`          | `GET /mailboxes/{mailbox}/threads/{threadId}`                       |
| `getAttachment`       | `GET /mailboxes/{mailbox}/messages/{messageId}/attachments/{index}` |
| `waitForEmail`        | `GET /wait`                                                         |
| `getVerificationCode` | `GET /verification-code`                                            |
| `sendEmail`           | `POST /mailboxes/{mailbox}/messages`                                |
| `reply`               | `POST /mailboxes/{mailbox}/messages/{messageId}/reply`              |
| `listAddresses`       | `GET /mailboxes/{mailbox}/addresses`                                |
| `createAddress`       | `POST /mailboxes/{mailbox}/addresses`                               |
| `endAddress`          | `DELETE /mailboxes/{mailbox}/addresses/{addressId}`                 |
| `listWebhooks`        | `GET /webhooks`                                                     |
| `createWebhook`       | `POST /webhooks`                                                    |
| `updateWebhook`       | `PATCH /webhooks/{webhookId}`                                       |
| `deleteWebhook`       | `DELETE /webhooks/{webhookId}`                                      |
| `testWebhook`         | `POST /webhooks/{webhookId}/test`                                   |

Their inputs and answers are the types `SendEmailInput`, `SendEmailOutput` and so on, with the
API's own words on each field. `mail.call("send_email", input)` calls a route by its operationId.
Every method takes `{ signal }` as a second argument, to stop it. A mailbox is named by its id, its
name or one of its addresses.

`waitForEmail` and `getVerificationCode` wait up to `timeoutSeconds` (30 unless you say, 50 at
most) and give `found: false` when nothing came; a key may start 30 waits in 10 minutes. Without
`since`, mail from the 5 minutes before the call counts too.

Mail is how a stranger reaches an agent: a message's subject, names and text are the sender's
words, to treat as data, never as instructions. Its From proves nothing unless `verifiedDomain` is
that address's domain. `getVerificationCode` takes only mail whose sender DMARC proved, unless you
pass `provedOnly: false`.

### Errors

When Mail doesn't do what was asked, a method throws a `MailError`:

```ts
try {
	await mail.sendEmail(message);
} catch (error) {
	if (!(error instanceof MailError)) throw error;
	console.log(error.status, error.message, error.issues, error.retryAfter);
}
```

- `status`: 400 for a request the route doesn't take, 401 for a key that is wrong or revoked, 403
  for what the agent's grants or policy don't let it do (or a paused agent), 404 for a mailbox,
  message or webhook it may not reach, 409 for what can't be done as things are, 429 for too many,
  500 for Mail's own trouble.
- `message`: why, in Mail's words.
- `issues`: for a 400, what in the request is wrong, as `{ path, message }`.
- `retryAfter`: for a 429, in how many seconds to try again, when Mail says.

The key is never in an error. A method throws a `TypeError` when its path lacks an input, and a
failure to reach Mail at all comes from `fetch` as it is.

### Webhooks

A webhook the agent makes with `createWebhook` posts each event to your URL, signed per
[Standard Webhooks](https://www.standardwebhooks.com) with the `whsec_` secret that answer gives,
once. Check each delivery with `verifyWebhook`, on the body exactly as it came:

```ts
import { verifyWebhook, WebhookError } from "@gateweave/mail";

export default {
	async fetch(request: Request, env: Env): Promise<Response> {
		try {
			const event = await verifyWebhook({
				secret: env.MAIL_WEBHOOK_SECRET,
				headers: request.headers,
				body: await request.text(),
			});
			if (event.type === "message.received") await queueForTheAgent(event.data);
			return new Response("ok");
		} catch (error) {
			if (error instanceof WebhookError) return new Response(error.message, { status: 401 });
			throw error;
		}
	},
};
```

It checks every `v1,` signature in `webhook-signature` against `webhook-id`, `webhook-timestamp`
and the body, in constant time, and refuses a delivery signed more than `toleranceSeconds` (300)
from now. `headers` may be a `Headers` or a plain object, such as Node's `request.headers`, and
`body` a string or bytes. It gives the event, `{ type, timestamp, data }`, or throws a
`WebhookError` saying why not. A retry carries the same `webhook-id`, so keep the ids you handled.
An event names the workspace, the mailbox and the message, never its text: read that with the key.

## The command line

```sh
export GATEWEAVE_MAIL_URL=https://mail.example.com
export GATEWEAVE_MAIL_KEY=…   # from your CI's secrets

since=$(date -u +%Y-%m-%dT%H:%M:%SZ)
./sign-up.sh signups@acme.example
code=$(gateweave-mail code --to signups@acme.example --from github.com --since "$since")
```

| Command          | What it does                                                                       |
| ---------------- | ---------------------------------------------------------------------------------- |
| `code`           | Waits for a verification code, and prints only the code.                           |
| `wait`           | Waits for a message, and prints it as JSON.                                        |
| `send`           | Sends a message, and prints what became of it as JSON.                             |
| `verify-webhook` | Checks a webhook delivery's signature, and prints its event's type.                |
| `call`           | Calls any route by its operationId, with its input as JSON, and prints its answer. |

```sh
# A code from mail to an address, from a sender: an address, or a domain and those under it.
# It also takes --mailbox, --subject, --since, --timeout and --unproved.
gateweave-mail code --from github.com --to signups@acme.example --since 2026-11-11T09:59:00Z

# A message, with the same filters; --from may be left out.
gateweave-mail wait --to signups@acme.example --subject Welcome > message.json

# --text, --text-file or --html-file, with files; --to, --cc and --attach again for each more.
gateweave-mail send --mailbox Sign-ups --to someone@example.org --subject "The report" \
  --text-file report.txt --attach report.pdf --from signups@acme.example

# A delivery your receiver kept, with its headers.
gateweave-mail verify-webhook --id "$WEBHOOK_ID" --timestamp "$WEBHOOK_TIMESTAMP" \
  --signature "$WEBHOOK_SIGNATURE" --body-file body.json

# Any route, with its input as an argument or on standard input.
gateweave-mail call search_email '{"mailbox": "Sign-ups", "query": "invoice"}'
echo '{"webhookId": "…"}' | gateweave-mail call test_webhook
```

`code` and `wait` call the API's wait again and again, each for at most 50 seconds, until
`--timeout` (120 seconds unless you say) runs out, and after a 429 wait as long as Mail says when
that time allows. They take only mail whose sender DMARC proved, unless you pass `--unproved`.
Without `--since`, they take only mail that arrives once the command has started, where the API by
itself would take mail from the 5 minutes before too, such as an older code. So take the time
before you set off the mail, from a clock that is right, and pass it as `--since`. When the message
came but Mail could tell no code apart in it, `code` says how to read it with `call read_email`.

`--url` gives Mail's address instead of `GATEWEAVE_MAIL_URL`, `--help` shows every option, and
`--version` the version.

### Environment

| Variable                        | What it is                                                                  |
| ------------------------------- | --------------------------------------------------------------------------- |
| `GATEWEAVE_MAIL_URL`            | Your Mail's address, such as `https://mail.example.com`.                    |
| `GATEWEAVE_MAIL_KEY`            | The agent's key.                                                            |
| `GATEWEAVE_MAIL_WEBHOOK_SECRET` | The webhook's `whsec_` secret, for `verify-webhook`, as Mail gave it, once. |

The key and the secret are read only from the environment, never from a flag, so that they stay out
of shell history and lists of processes, and the command never prints them.

### Exit codes

| Code | Meaning                                                            |
| ---- | ------------------------------------------------------------------ |
| 0    | Done.                                                              |
| 1    | Mail refused, nothing came in time, or the signature doesn't hold. |
| 2    | Wrong usage, or a setting missing.                                 |

When Mail refuses, the command says what its answer means: for a 401, that the key is wrong or was
revoked; for a 403, that the agent's grants or policy don't let it, or that it is paused.

## In this repository

The types in `src/api.gen.ts` are made from `openapi.json`, the agent API's OpenAPI document as Mail
serves it at `/api/v1/openapi.json`, which a test in `apps/web` keeps current. After changing an
operation in `apps/web/src/server/agent-api`:

```sh
pnpm --filter @gateweave/mail-web exec vitest run --project unit -u src/server/agent-api
pnpm --filter @gateweave/mail generate
```

`pnpm --filter @gateweave/mail test` fails while `src/api.gen.ts` isn't what the document makes.
`apps/web/test/sdk.test.ts` runs the SDK and the command line against the built Worker.

## License

[AGPL-3.0-only](../../LICENSE), as the rest of Gateweave Mail.
