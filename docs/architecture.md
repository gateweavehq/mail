# Architecture

How Gateweave Mail is built today, and the shape it is planned to take. This file changes with
the code.

## What exists

One Worker (`apps/web`), the same shape as Gateweave Track and Gateweave Agents:

- **TanStack Start** renders pages on the server and hydrates them in the browser. Server
  functions are the API: each one checks the session and, for workspace data, the caller's
  membership before doing anything.
- **Better Auth** owns accounts, sessions, workspaces (its organizations), members, roles and
  invitations, stored in **D1**. There is one Better Auth instance per isolate, built on first
  use, because workerd forbids I/O in global scope. It can also sign people in through an OpenID
  Connect provider, and through GitHub: see "Signing in through a provider" below.
- **Rate limits** on sign-in, password reset, invitations and email are counted in a
  `RateLimiter` Durable Object per client address or recipient, so they hold across isolates and
  locations. Everything else is limited in memory per isolate. Every Worker reaches another zone
  from one address, `2a06:98c0:3600::103`, so a request with that address and a `cf-worker` header
  is counted by the zone it names, which Cloudflare sets and a sender cannot change
  (`workers-address.ts`). Better Auth counts a request before anything in it can step in, so the
  request is changed before it gets there.
- **Email** goes through Cloudflare Email Service when `EMAIL_FROM` is set: password reset,
  verification and invitations. Without it, invitations are links to share.
- **What is past its time** goes once a day, on a Cron Trigger every deployment inherits from
  `wrangler.jsonc` (`apps/web/src/server/db/prune.ts`). Better Auth removes a session or a
  verification only when something looks it up, so those nobody comes back for would otherwise
  stay, with the address and browser a session holds, and invitations with the address they were
  sent to.
- **Headers** go on every answer (`apps/web/src/server/security-headers.ts`): `nosniff`, a referrer
  rule and, over HTTPS, `Strict-Transport-Security`. A page also gets `X-Frame-Options`,
  `Cache-Control: private, no-store` and a Content-Security-Policy with a nonce made for that
  response. Pages will show mail someone else wrote, so nothing can frame a page, a script runs
  only from this Worker's own address or with the nonce, and a page connects only to this Worker.
  A member's picture is the one thing a page shows from elsewhere, and only from GitHub or the
  sign-in provider. Vite's dev server gets none of this, because its hot reload adds scripts
  without a nonce.
- **A deployment without its database or `BETTER_AUTH_SECRET`** serves a 503 that says so and
  nothing else. A branch's Preview is one, since it gets none of the Worker's bindings.
- **The directory** (`apps/web/src/server/directory/`) says which addresses exist. D1 holds
  domains, mailboxes and addresses, because `email()` has to answer from anywhere with one query.
  A workspace proves a domain with a TXT record at `_gateweave-mail.<domain>`, and each domain or
  subdomain is proved on its own: an address matches its domain exactly. Only one workspace holds
  a proved domain, and a unique index keeps it so. A claim proves nothing, so anyone may make one,
  and whoever runs the domain's DNS now decides: a fresh proof moves the domain from its holder,
  since a record removed after it served is normal and someone who once had DNS access mustn't
  keep a domain from its owner for good. While the holder's record is there too, nothing moves.
  Triggers refuse an address whose domain and mailbox are in different workspaces, whatever a bug
  above them does. An address that ends by itself keeps its name for 30 days, refusing mail, so
  it doesn't pass to someone else while what it signed up for still writes to it. Removing one by
  hand, after a confirmation, frees the name at once, since a person chose that. Pages read the
  directory through a server function, and changes go through `/api/directory/<workspace>`; both
  answer a non-member as a missing workspace, and only an owner or admin can change anything.
- **The `email()` handler** (`apps/web/src/server/inbound.ts`) looks up each message's address on
  the primary, never a replica, so a new address works at once. No such address gets
  `setReject("No such address")`, for good. A known address gets a throw, which tells the sender
  to try again, until mailboxes can store mail: accepting a message we can't keep would lose it.
  So does a failure of the database. The Worker tests deliver to it through Miniflare
  (`test/inbound.test.ts`, `test/directory.test.ts`).

### Workspaces

Workspaces are Better Auth organizations. Members have a role: `owner`, `admin` or `member`.
What only owners and admins may do is decided with `isAdminRole` (`apps/web/src/lib/roles.ts`),
never by comparing a role with `member`. Every server function that touches a workspace starts at
`currentMember`, and a non-member gets the same "not found" as a missing workspace.

Two triggers on `member` (`apps/web/migrations/0001_owner_triggers.sql`) make sure a workspace
keeps an owner however a row comes to change, because the plugin and the account deletion endpoint
both count owners and then act, and two owners leaving at once could each see the other still
there. They let go of a workspace that is being deleted, which is why
`beforeDeleteOrganization` deletes the organization row first and its members follow by cascade.

### Signing in through a provider

With `OIDC_ISSUER`, `OIDC_CLIENT_ID` and `OIDC_CLIENT_SECRET` set, Mail is a client of an OpenID
Connect provider, through Better Auth's `generic-oauth` plugin
(`apps/web/src/server/auth/oidc-sign-in.ts`). What comes out of it is an account row and an
ordinary session, so nothing past the sign-in page knows the difference. Gateweave Track and
Gateweave Agents have the same code, and the same reasons.

- **Discovery waits until someone needs it.** The plugin's `init` waits for the provider's discovery
  document with no time limit, and every request to a new isolate waits for `init`, so a slow
  provider would stop password sign-in and every session check. Mail replaces `init` so that each
  isolate starts as the plugin does after a failed discovery, which it retries, within 10 seconds,
  for a request that names the provider. That sets a field of the plugin's that is not public, so an
  upgrade that moves it fails the tests rather than the deployment.
- **Linking is never assumed.** The provider is not in `trustedProviders`, so an existing account
  links only when the provider says the address is verified and Mail's account has verified it too.
  Anything but a JSON `true` in `email_verified` counts as unverified, since some providers send text.
- **Mail keeps no tokens.** It signs people in and never acts for them at the provider, so the
  account hook clears them all, and the ID token too, as soon as it has served its purpose. The same
  goes for signing in with GitHub. The client authenticates with `client_secret_basic`, which every
  provider has to take.
- **The provider can end sessions.** `POST /api/auth/backchannel-logout/oidc` takes a logout token,
  checked against the provider's keys: issuer, audience, at most 5 minutes old, the logout event and
  no nonce. A session row keeps the `sid` of the ID token it came from (`session.oidc_sid`, never
  sent to the browser), and a token naming a `sid` ends just those sessions, and only if they belong
  to the `sub` it may also name. A token naming only a `sub` ends everything of that person's. Once
  a token has arrived it is seen through with `waitUntil`, even if the provider stops waiting. Keys
  that cannot be fetched at that moment get a 503 and end nothing.
- **Signing out of Mail stays in Mail.** The provider's session is left alone, and
  `disableProviderLogout` keeps the plugin from sending anyone there.

### Deleting an account

People delete their own account on `/settings/account`, through `POST /api/auth/account/delete`
(`apps/web/src/server/auth/delete-account.ts`). Better Auth's `/delete-user` stays off: it lets
someone with a password through without it.

- **What it asks for.** A session from the last day, and the password if the account has one. An
  account without one types its address in the page, which only guards against a slip. Better
  Auth's `/unlink-account` is disabled, because it removes a password on a recent session alone,
  which would let a stolen cookie get past that question. So are the other routes it offers any
  session and the app has no use for, such as `/verify-password`, which takes guesses at a
  password. The list is `disabledPaths` in `apps/web/src/server/auth/config.ts`, and
  `apps/web/src/server/auth/routes.test.ts` fails when an upgrade adds a route to what answers, so
  someone decides about it.
- **A workspace keeps an owner.** The only owner of a workspace is refused and told which.
- **D1 goes in one batch:** the user is deleted and the invitations addressed to them are taken.
  Foreign keys take the sessions, sign-ins, memberships and the invitations they sent. A trigger's
  refusal leaves everything in place.

When mailboxes exist, they will need their own rule here for what happens to a deleted person's
mail. That is not decided yet.

### Changing a name or password

People change both on `/settings/account`, through Better Auth's `/update-user` and
`/change-password`, and what stands behind either may be a stolen cookie. The rules are in
`apps/web/src/server/auth/account-changes.ts` and the hooks of `config.ts`.

- **A rename takes a name and nothing else:** 1 to 100 characters once trimmed, which sign-up keeps
  to as well. The route would otherwise set a picture too, whose address everyone in someone's
  workspaces fetches. It allows ten a minute.
- **A new password needs the current one,** at five tries a minute from one client address, and
  sends the person an email, which may be how they first hear that someone else has it.
- **Tries at a password are also held per person,** since a stolen cookie can be sent from many
  addresses (`apps/web/src/server/auth/password-tries.ts`). This and deleting an account share an
  allowance of 10 at once, refilling over an hour, within 30 that refill over a day. Only a request
  with a session for that account spends it, so nobody can lock a person out with their address
  alone, and signing in is not part of it. When it runs out the person gets an email saying so, at
  most once a day and only at an address they have verified.
- **It ends every session,** whatever the request asks, since whoever knew the old password may be
  why it is changing and may be the one asking.

## Planned shape

Not built. This is where it is going, and it may change.

- **One Worker.** The UI, the API, auth and `email()` stay together.
- **One Durable Object per mailbox**, which orders what arrives, holds the mailbox's index and
  makes handling the same message twice change nothing.
- **R2 for raw mail.** `email()` stores the raw message and hands off; parsing happens elsewhere,
  because the handler has about 2 seconds of CPU.
- **D1 for accounts and the address directory.** The directory says which address belongs to which
  mailbox, so `email()` can look an address up and refuse the ones that do not exist.

## What Cloudflare does with mail

Measured on 2026-11-07. These shape the design above, and Cloudflare may change them.

- **A zone has one catch-all rule,** and it also catches mail for subdomains that have Email
  Routing enabled.
- **A zone can have 200 literal routing rules,** across the whole zone, not per Worker.
- **A new literal rule takes from about half a minute to over a minute to work.** An address
  cannot be handed out and used in the same moment through rules, which is why the catch-all and
  our own directory are planned to decide, not a rule per address.
- **Every SMTP answer comes after the whole message is sent.** A refusal does not save the
  sender's upload, and a message over 25 MiB is answered `552`.
- **The `email()` handler has about 2 seconds of CPU,** and `limits.cpu_ms` does not change that.
- **Delivery is at least once.** A handler that runs for about 5 minutes is cancelled and run
  again, and a sender retries after a temporary refusal.
- **A thrown error is a `421`,** which tells the sender to try again. `setReject` is a `555`,
  permanent.
- **`dmarc=pass` is the only proof of a sender.** A forged message can arrive with
  `Authentication-Results` saying `dmarc=none`.
