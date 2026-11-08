# Self-hosting

Gateweave Mail runs on your own Cloudflare account as one Worker. It is early: today it has
accounts, workspaces, a directory of addresses, and mailboxes that keep the mail sent to them and
reply and write in plain text. It uses:

- a D1 database for accounts, the list of workspaces, and their domains, mailboxes and addresses;
- an R2 bucket for mail as it arrived, one object per message;
- a Durable Object per mailbox, which holds the index of its messages;
- a Durable Object that counts rate limits, one per client address or recipient;
- a queue, `gateweave-mail-events`, for Email Service's delivery events;
- optionally, Cloudflare Email Service, to send password resets, verification and invitations,
  and the mail people write from mailboxes.

You need a Cloudflare account with the **Workers Paid** plan. Sign-in takes more CPU than the Free
plan gives a request, and Email Sending is a Paid feature. Turn on R2 in the account before the
first deploy, by opening R2 in the dashboard once and following its steps: until then, the bucket
can't be created, and the deploy fails.

**Getting a domain's mail to the Worker.** Prove the domain under a workspace's Settings, then turn
on Email Routing for that same domain in the Cloudflare account that runs the Worker. Each domain
or subdomain is proved on its own: proving `example.com` gives no addresses on
`mail.example.com`. Then choose:

- **Send its catch-all to the Worker.** The Worker decides which addresses exist, and a new one
  works at once. A zone has one catch-all, and it also catches every subdomain with Email Routing
  on, so use this where nothing else needs it.
- **Add a routing rule per address.** Use this when something else holds the catch-all. A zone gets
  200 rules in all, and a new one can take over a minute to work, with mail going to the catch-all
  until it does.

A domain whose DNS isn't on that Cloudflare account can receive through
[Resend](https://resend.com) instead: see [Email](#email).

Mail is early, so think before doing this for a domain people rely on: what arrives is kept and
shown, and a message to an address that doesn't exist is refused. You can
deploy without Email Routing. Proof stays after the TXT record is removed, but whoever runs the
domain's DNS decides who holds it: if another workspace on the same server proves it later, it
moves to them, unless your record is still there too.

There are two ways to deploy: the button, which also sets up deploys on every push, or the
command line.

## Deploy with the button

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/gateweavehq/mail)

The button copies this repository to your GitHub or GitLab account and connects the copy to
Workers Builds, so every push to its main branch deploys. On the form:

- **Git account** is the first field, the account the copy goes to. If nothing is connected yet,
  connect GitHub or GitLab there.
- **Project name** names the Worker. It answers on `<project name>.<your subdomain>.workers.dev`.
- **D1 database**: choose **+ Create new** and give it a name. The form picks an existing database
  when one in your account has the name in `wrangler.jsonc` (`gateweave-mail`), so check it
  before you deploy.
- **R2 bucket** holds the mail. Make a new one in the same way, and check that the form hasn't
  picked an existing bucket named `gateweave-mail`.
- **Queue**: the form creates `gateweave-mail-events`, which brings Email Service's delivery
  events (see [Email](#email)). Let it make a new one.
- **BETTER_AUTH_SECRET** signs sessions. Use a long random string, for example from
  `openssl rand -base64 32`, and keep it secret. Changing it later signs everyone out.
- Leave the build and deploy commands as they are. The deploy command applies the database
  migrations before the new code goes live.

When the build finishes, open the Worker's address, create an account and then a workspace.
Anyone who can reach the address can sign up and create workspaces of their own; a workspace is
only visible to its members.

**Preview builds.** The button turns them on: a push to any other branch builds a Preview with its
own URL. A Preview gets none of the Worker's bindings or secrets, so its address only says that it
is not set up, and it cannot reach your data. To make Previews work, create another D1 database and
apply the migrations to it, name it and the Durable Objects under `previews` in `wrangler.jsonc` as
[Cloudflare's guide](https://developers.cloudflare.com/workers/previews/resources/) shows, and give
them a secret of their own with `pnpm wrangler preview base-config secret put BETTER_AUTH_SECRET`.
If you don't need them, untick **Enable Preview builds** on the form, or turn them off later under
Settings › Build › Branch control.

**Dependabot.** The copy brings this repository's `.github/dependabot.yml`, so Dependabot opens a
pull request on it within minutes, and weekly after that. You don't need them: a release brings
updates that were tested together, and what you merge can conflict with the next update. Delete the
file unless you want them, and close what it opened.

## Deploy from the command line

Requirements: Node.js 24 (22+ works) and pnpm 12.

```sh
git clone https://github.com/gateweavehq/mail.git
cd mail
pnpm install
pnpm wrangler login
pnpm run deploy
```

`pnpm wrangler` runs the Wrangler version Mail pins, from the repository root. The Worker, its
database and its bucket are named `gateweave-mail`. To use other names, change `name`,
`database_name` and `bucket_name` in `wrangler.jsonc` before the first deploy.

The first deploy does three things:

1. It creates the D1 database, the R2 bucket, the queue and the Durable Object namespaces.
2. It generates `BETTER_AUTH_SECRET`, which is never shown.
3. It applies the migrations.

Every later `pnpm run deploy` builds, applies new migrations, and only then deploys.

Then open the Worker's address, create an account and then a workspace. Anyone who can reach the
address can sign up and create workspaces of their own. A workspace is only visible to its members.

## Where the database lives

Every read and write of an account or a session goes to one place, the D1 database's primary, and
D1 puts it close to whoever asked for the database unless told otherwise. That may be far from your
people. To choose, make the database yourself before the first deploy, with a location hint
(`wnam`, `enam`, `weur`, `eeur`, `apac` or `oc`):

```sh
pnpm wrangler d1 create gateweave-mail --location apac
```

Then pick it instead of **+ Create new** on the button's form, or put its id in `wrangler.jsonc` as
`database_id`.

## Where mail is kept

Each message goes into the R2 bucket as it arrived, one object per message, and each mailbox's
Durable Object holds the index of its messages. A mailbox holds up to 1 GiB, which
`MAILBOX_BYTES` changes; past that, a sender is told to try again later, and an owner or admin can
delete messages to make room. Removing a mailbox, or deleting its workspace, removes its mail at
once. The database keeps a record of each removal, and a daily run removes the mail again an hour
or more later, for a removal that stopped part way, then forgets the record. Mail only touches its
own mailboxes' objects, so the bucket can hold other things too. Deleting an account leaves mail
alone, since it belongs to the workspace.

R2 storage and Durable Object storage are billed past what the plan includes: see
[R2 pricing](https://developers.cloudflare.com/r2/pricing/) and
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
R2 has no point-in-time recovery, so restoring D1 doesn't bring back removed mail.

## Settings

Everything except `BETTER_AUTH_SECRET` is optional. Set them in the Cloudflare dashboard (Workers &
Pages › your Worker › Settings › Variables and Secrets), or from the repository root:

```sh
pnpm wrangler secret put BETTER_AUTH_URL
```

Keep tokens, keys and email addresses as secrets. Plain variables stay through a deploy too,
because `wrangler.jsonc` sets `keep_vars`.

| Name                   | What it does                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `BETTER_AUTH_SECRET`   | Signs sessions. Required.                                                                                          |
| `BETTER_AUTH_URL`      | The address people use, such as `https://mail.example.com`. Inferred from each request when unset.                 |
| `GITHUB_CLIENT_ID`     | Turns on "Sign in with GitHub", with `GITHUB_CLIENT_SECRET`.                                                       |
| `GITHUB_CLIENT_SECRET` | The client secret of the same GitHub OAuth app.                                                                    |
| `OIDC_ISSUER`          | Turns on an OpenID Connect provider, with the two below. See [below](#sign-in-through-an-openid-connect-provider). |
| `OIDC_CLIENT_ID`       | This deployment's client ID at the provider.                                                                       |
| `OIDC_CLIENT_SECRET`   | Its client secret there.                                                                                           |
| `OIDC_PROVIDER_NAME`   | What the sign-in button calls it. Unset: "single sign-on".                                                         |
| `EMAIL_FROM`           | Turns on email (invitations, password reset), such as `Gateweave Mail <mail@example.com>`.                         |
| `MAILBOX_BYTES`        | How many bytes one mailbox may hold, as a whole number. Unset: 1 GiB.                                              |
| `SEND_PER_DAY`         | How many messages one workspace may send from its mailboxes a day, as a whole number. Unset: 200.                  |
| `SECRETS_KEY`          | Encrypts workspaces' keys, such as a Resend key: 32 random bytes, base64. None can be added without it.            |
| `LEGAL_NOTICE_URL`     | The address of your legal notice. See [below](#your-legal-pages).                                                  |
| `PRIVACY_POLICY_URL`   | The address of your privacy policy.                                                                                |
| `TERMS_URL`            | The address of your terms.                                                                                         |

### Your own domain

In the dashboard, open the Worker and add a custom domain under Settings › Domains & Routes. Or
add `"routes": [{ "pattern": "mail.example.com", "custom_domain": true }]` to `wrangler.jsonc`.
Then set `BETTER_AUTH_URL` to that address, and use it in the OAuth apps' URLs. Sign-in needs HTTPS:
session cookies are marked `Secure`, so a browser won't keep them over plain HTTP. Turn on
[Always Use HTTPS](https://developers.cloudflare.com/ssl/edge-certificates/additional-options/always-use-https/)
for the domain so that nobody lands on the plain address.

Mail's pages refuse scripts they did not name, so a zone setting that adds scripts to a page does
nothing here or gets in the way. [Web Analytics' automatic setup and Rocket Loader](https://developers.cloudflare.com/fundamentals/reference/policies-compliances/content-security-policies/)
are two of them: leave those off for this hostname.

### Your legal pages

Mail comes with no legal notice, privacy policy or terms, and never links to Gateweave's: whoever
runs a copy decides what applies to it. Set any of the three addresses above, and it is linked from
the sign-in pages and the workspace menu. With `TERMS_URL` set, the sign-in page also says that
continuing means agreeing to them.

### Email

Mail sends email through [Cloudflare Email Service](https://developers.cloudflare.com/email-service/).
Onboard the sender's domain once with `pnpm wrangler email sending enable example.com`, then set
`EMAIL_FROM` to an address on it. Without email, Mail works, but invitations have to be accepted
from a link that an admin copies, and nobody can reset a forgotten password for themselves.

Mailboxes send through the same binding, from their own addresses, whether `EMAIL_FROM` is set or
not. Onboard each domain whose addresses should send the same way. Until it is, a message from it
is refused, and its copy in the thread says why. A workspace sends up to 200 messages a day, which
`SEND_PER_DAY` changes; Email Service has limits of its own for the account, and won't send to an
address that bounced or complained before. An agent also has a day's count of its own, which an
owner or admin sets on the Agents page, and mail it writes that waits for approval counts against
the workspace's day only once it is approved.

**Delivery events.** Email Service says what each recipient's mail server did with a message:
delivered, delayed, bounced, failed, not sent, or marked as spam. Mail shows it under the message
in its thread. The events reach the Worker through the `gateweave-mail-events` queue, which needs
a subscription for each domain that sends through Email Service, with the domain's zone id from
its Overview page in the dashboard:

```sh
pnpm wrangler queues subscription create gateweave-mail-events --source email.sending \
  --events message.delivered,message.deferred,message.bounced,message.failed,message.rejected,message.complained \
  --zone-id <zone id> --domain example.com --name mail-events-example-com
```

Give each domain's subscription a name of its own. A subscription takes a few minutes to start.
Settings › Domains says when events last came for each domain that sends this way, so a missing
one shows. Events for mail that other apps send from the same domain reach the queue too, and Mail
drops them. Queue operations past what the plan includes are billed: see
[Queues pricing](https://developers.cloudflare.com/queues/platform/pricing/).

**Suppressions.** When mail to an address bounces for good, or its person marks it as spam, the
events also put the address on the workspace's suppression list, and its mailboxes stop sending
to it: a send to it is refused, naming it. A complaint stays until someone removes it; a bounce,
or a send Email Service refused for its own list, ends after a week, except a bounce for a
mailbox or domain that doesn't exist. Owners and admins see the list in Settings › Suppressions
and can remove an address there. Email Service keeps a list of its own for the account, which
that doesn't change: see it in the dashboard under **Compute** > **Email Service** >
**Email Sending** > **Suppressions**, where an entry that isn't read-only can be deleted. Without
the subscription, Mail's list stays empty and only Email Service's applies.

A domain whose DNS isn't on the Cloudflare account that runs Mail can't be onboarded there, so it
can send through [Resend](https://resend.com) instead, with each workspace's own key. Set
`SECRETS_KEY` once, which encrypts those keys:

```sh
openssl rand -base64 32 | pnpm wrangler secret put SECRETS_KEY
```

Then, in the workspace, an owner or admin verifies the domain at Resend, adds a Resend key under
Settings › Domains, and sets the domain to send with Resend. A key that may only send is enough.
Keep `SECRETS_KEY` as it is: the keys sealed with it can't be opened with another, and would have
to be added again. Resend's own limits and quotas apply to that account.

Such a domain can receive through Resend too. In Resend, turn on receiving for the domain and add
the MX record it shows; as a domain's mail goes to one place, use a subdomain when the domain
already gets mail elsewhere. The workspace's key then needs full access, since a sending-only key
can't read received mail. Set the domain to receive with Resend under Settings › Domains: Mail
makes a webhook in that Resend account, pointing at `/api/inbound/resend/…` on the server's
address (`BETTER_AUTH_URL`), which has to be reachable from the internet, and removes it when no
domain receives with Resend. Resend turns off a webhook whose deliveries keep failing, as while
the server is down for long; "Check the webhook" on the same page turns it back on.
Resend takes mail for every address on the domain, so mail to an address that doesn't exist in
Mail is left out rather than refused, and stays in Resend.

As you hold the database, you can do it for them, from the repository root. Find their `id` in this
list. Don't paste an address someone sent you into a command, as it could run as part of it:

```sh
pnpm wrangler d1 execute DB --remote --command "SELECT id, email FROM user ORDER BY email"
```

Then make a link for that `id`. It works once, for an hour, and using it signs them out everywhere.
Whoever opens it can choose the password, so send it only to them:

```sh
PERSON=the-id-from-that-list
TOKEN=$(openssl rand -hex 32)
pnpm wrangler d1 execute DB --remote --command \
  "INSERT INTO verification (id, identifier, value, expires_at) VALUES ('$TOKEN', 'reset-password:$TOKEN', '$PERSON', (unixepoch() + 3600) * 1000)"
echo "https://your-server/reset-password?token=$TOKEN"
```

### Sign in through an OpenID Connect provider

Any OpenID Connect provider can sign people in: Gateweave ID, Pocket ID, authentik, Keycloak, Okta
and others. It adds a button to the sign-in page, and passwords keep working.

1. Register Mail with the provider as a confidential client that uses the authorization code
   flow and `client_secret_basic`, with the scopes `openid`, `profile` and `email`:
   - Redirect URI: `https://mail.example.com/api/auth/callback/oidc` (your address)
   - Back-channel logout URI, if the provider has them:
     `https://mail.example.com/api/auth/backchannel-logout/oidc`
2. Set `OIDC_ISSUER` to the provider's issuer, the address its
   `/.well-known/openid-configuration` is under, then `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET`.
   `OIDC_PROVIDER_NAME` names the button, as in "Continue with Acme".

Someone new gets an account, named as the provider names them, and can change that name in Mail
without the provider changing it back. Someone whose address already has one links to it only when
the provider says the address is verified and they have verified it in Mail too, so anyone who could
sign up at the provider with that address cannot take over the account. Without
[email](#email) nobody can verify an address in Mail, so existing accounts stay with their
passwords.

If the provider is down, its button says so, and everything else keeps working. People already
signed in stay signed in, because Mail asks the provider nothing except when someone uses that
button or the provider signs someone out. With the back-channel logout URI registered, signing out
at the provider ends the Mail sessions it started. Signing out of Mail leaves the provider's
session alone.

A member's picture shows when it comes from the provider's own host or from GitHub. From anywhere
else, the page's policy stops it and their initials show instead.

If Mail and the provider are both Workers, give each a
[Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/#worker-to-worker-communication).
A Worker cannot reach another on its own zone through a route, and two on `workers.dev` cannot reach
each other at all: Cloudflare answers with error 1042, and the button says it could not reach the
provider. If they have to stay on `workers.dev`, add `global_fetch_strictly_public` to
`compatibility_flags` in each one's `wrangler.jsonc`.

## When someone deletes their account

People delete their own account on `/settings/account`, with no setting to turn on. The account,
its sessions and sign-ins, its memberships, the invitations it sent and the invitations addressed
to it are deleted from D1 at once. An account that is the only owner of a workspace is refused
until someone else owns it or it is deleted. Workspaces they belonged to stay with the people still
in them. Cloudflare keeps point-in-time recovery for D1 (30 days on Workers Paid, 7 on Free), and
restoring D1 to a time before a deletion brings the person back.

## Updating

**Command line:**

```sh
git pull
pnpm install
pnpm run deploy
```

The deploy applies new D1 migrations before the new code goes live.

**Button:** your copy does not follow this repository on its own, and shares no history with it,
so `git pull` refuses. This takes the latest release into your copy instead, as one commit on top
of it. A copy can skip releases, however old it is:

```sh
git remote add upstream https://github.com/gateweavehq/mail.git   # once
git fetch upstream
git show upstream/main:scripts/update-copy.mjs | node --input-type=module
git push
```

The script pushes nothing, and `git reset --hard HEAD~1` undoes it until you do. The push is what
deploys: Workers Builds builds it and applies the D1 migrations.

Since delivery events came in, Mail also deploys a queue. If the build of an update stops, saying
its API token can't reach Queues, add the permission Account › Queues › Edit to that token (the
Worker's Settings › Build shows which one it is, under My Profile › API Tokens), then retry the
build. The deploy stops before it changes anything.

If GitHub refuses the push with `push declined due to email privacy restrictions`, the commit
carries the address your GitHub settings keep private. Use the `noreply` address those settings
show you, and make the commit again:

```sh
git config user.email "<your noreply address>"
git commit --amend --reset-author --no-edit
git push
```

What your copy changed stays: the Worker's and database's names in `wrangler.jsonc`, the name in
`package.json`, and having no workflows. If something else you changed conflicts with the release,
the script names the files for you to fix before committing. To take a release other than the
latest, end the third line with `node --input-type=module - --to v1.2.3`.

Mail is in early development. Read [CHANGELOG.md](../CHANGELOG.md) before updating, as some
releases change how things work.
