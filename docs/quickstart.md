# Quickstart

A fresh clone gets you Gateweave Mail on your own Cloudflare account, at a workers.dev address,
deployed from the command line, with you signed in as its first account, a workspace, a mailbox and
an address on a domain you have proved with one TXT record. Following this page on 26 November 2026
took about 4 minutes up to adding the TXT record, starting from an empty package cache, not counting
installing the tools below or signing in to Cloudflare. The DNS steps after that depend on your DNS
host and weren't timed.

This is the shortest path: no custom domain for the Worker, no Email Routing and no Email Sending.
Without Email Routing nothing reaches the address, and without Email Sending nothing leaves it, so
this page stops at an address that exists. Receiving and sending are in
[self-hosting.md](self-hosting.md).

## What you need

- A Cloudflare account on the Workers Paid plan. The Free plan gives a request too little CPU for a
  password sign-in; [self-hosting.md](self-hosting.md) has the numbers. R2 must be turned on once
  in the dashboard, under R2 Object Storage, because Mail keeps each message there: until then the
  deploy fails when it makes the bucket.
- [Git](https://git-scm.com/downloads).
- [Node.js](https://nodejs.org) 24, the version in `.node-version`, and
  [pnpm](https://pnpm.io/installation) 12.
- A browser, for signing in to Cloudflare and for Mail itself.
- A domain whose DNS you can edit, to add one TXT record. `example.com` below stands for yours.

## Steps

1. Get the code.

   ```sh
   git clone https://github.com/gateweavehq/mail.git
   cd mail
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Cloning into 'mail'...
   ```

   </details>

2. Install the dependencies.

   ```sh
   pnpm install
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Packages: +351
   ++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
   Progress: resolved 351, reused 0, downloaded 351, added 351, done

   devDependencies:
   + @biomejs/biome 2.6.8
   + typescript 7.0.2

   Done in 20s using pnpm v12.4.2
   ```

   Before these lines you may see download-progress lines, and lines from the install scripts of
   `workerd` and `esbuild`. The counts and the time differ a little from release to release and
   machine to machine. On a machine that has installed these packages before, `reused` is high and
   `downloaded` is 0.

   </details>

3. Sign in to Cloudflare. Wrangler, the Cloudflare command-line tool, opens your browser; approve
   its request there.

   ```sh
   pnpm wrangler login
   ```

   <details>
   <summary>Expected output</summary>

   ```text
   Attempting to login via OAuth...
   Opening a link in your default browser: https://dash.cloudflare.com/oauth2/auth?...
   Successfully logged in.
   ```

   </details>

4. Deploy. If your login can reach more than one Cloudflare account, the deploy can't ask which
   to use: run `pnpm wrangler whoami` to see them with their ids, then set
   `export CLOUDFLARE_ACCOUNT_ID=<id>` (in PowerShell, `$env:CLOUDFLARE_ACCOUNT_ID = "<id>"`) for
   the one you want.

   ```sh
   pnpm run deploy
   ```

   Nothing needs setting first. The deploy builds Mail, makes the queue for Email Service's delivery
   events, then creates the database, the bucket and the Durable Object classes, makes the secret
   that signs sessions (`BETTER_AUTH_SECRET`) and never shows it, and applies the database
   migrations. If your account has no workers.dev subdomain yet, Wrangler offers to register one:
   say yes. When Wrangler asks "Your database may not be available to serve requests during the
   migration, continue?", answer yes. The build prints a warning, `Missing required secrets:
   BETTER_AUTH_SECRET`, before the deploy makes that secret; ignore it.

   The Worker, the database, the bucket and the queue are called `gateweave-mail`,
   `gateweave-mail`, `gateweave-mail` and `gateweave-mail-events`. They come from `name`,
   `database_name`, `bucket_name` and the queue under `queues` in the top level of `wrangler.jsonc`;
   to use other names, change those four before this step. The Worker's name is also the first part
   of its address. The names under `env` are Gateweave's own deployments: leave them alone.

   <details>
   <summary>Expected output</summary>

   ```text
   ...
   (!) Your Vite config uses features that are unsupported by `configLoader: 'native'`, ...
     - import "./scripts/dev-secrets" without a file extension (vite.config.ts:10:28). ...
   (!) ... (the same warning, twice more)
   vite v8.3.8 building client environment for production...
   ...
   ✓ built in 12s
   vite v8.3.8 building ssr environment for production...
   ...
   WARNING Missing required secrets: BETTER_AUTH_SECRET. Add them to .dev.vars, .env, or set as environment variables.
   ...
   ✓ built in 6s
    ⛅️ wrangler 4.164.0 (update available 4.168.0)
   ✅ Created queue 'gateweave-mail-events'

   Configure your Worker to send messages to this queue:
   ...
   Configure your Worker to consume messages from this queue:
   ...
   Total Upload: 4682 KiB / gzip: 1101 KiB
   The following bindings need to be provisioned:
   Binding              Resource
   env.DB               D1 Database
   env.RAW_MAIL         R2 Bucket

   Provisioning DB (D1 Database)...
   Resource name found in config: gateweave-mail
   🌀 Creating new D1 Database "gateweave-mail"...
   ✨ DB provisioned 🎉

   Provisioning RAW_MAIL (R2 Bucket)...
   Resource name found in config: gateweave-mail
   🌀 Creating new R2 Bucket "gateweave-mail"...
   ✨ RAW_MAIL provisioned 🎉

   🎉 Resources provisioned, continuing with deployment...
   Durable Object exports reconciliation:
     Created: Audience, Mailbox, RateLimiter, Webhooks
   Worker Startup Time: 43 ms
   Your Worker has access to the following bindings:
   Binding                                    Resource
   env.RATE_LIMITER (RateLimiter)             Durable Object
   env.MAILBOX (Mailbox)                      Durable Object
   env.WEBHOOKS (Webhooks)                    Durable Object
   env.AUDIENCE (Audience)                    Durable Object
   env.EMAIL (unrestricted)                   Send Email
   env.DB (gateweave-mail)                    D1 Database
   env.RAW_MAIL (gateweave-mail)              R2 Bucket
   env.BETTER_AUTH_SECRET ("(hidden)")        Environment Variable
   Uploaded gateweave-mail (17 sec)
   Deployed gateweave-mail triggers (4 sec)
     https://gateweave-mail.<your-subdomain>.workers.dev
     schedule: 29 3 * * *
     Consumer for gateweave-mail-events
   Current Version ID: 0f3c1a52-7d4e-4b8a-9c61-2e5b8d7a1f34
   ...
   Migrations to be applied:
   ? About to apply 29 migration(s)
   Your database may not be available to serve requests during the migration, continue?
   ...
   │ 0028_agent_webhook_hosts.sql     │ ✅     │
   ```

   Your address is the `https://...workers.dev` line right after `Deployed ... triggers`, in the
   middle of the output: scroll up past the migration table, which comes after it and lists every
   migration with a tick. The last one is shown above, and the number of migrations grows with
   releases. The deploy takes about a minute and a quarter.

   </details>

5. Make the key that encrypts mail, keep a copy of it, and give it to the Worker. Run the first
   command and copy what it prints into a password manager or somewhere as safe.

   ```sh
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

   Then store it as a secret. Wrangler asks for the value: paste the key.

   ```sh
   pnpm wrangler secret put SECRETS_KEY
   ```

   Wrangler never shows a secret again, so your copy is the only one. Mail encrypted under one
   `SECRETS_KEY` can't be read under another: lose the key and you lose the mail it encrypted, and
   the keys and webhook signing secrets that workspaces keep with it. No mail arrives on this
   path, but set it now rather than after the first message. `openssl rand -base64 32` makes an
   equal key where OpenSSL is installed. To change the key later, follow "Changing the key" in
   [self-hosting.md](self-hosting.md#where-mail-is-kept).

   <details>
   <summary>Expected output</summary>

   ```text
   K3k0tq9b1v0Zr3m7oXwY5n2hQf8dUeJt6sLpCgAyN4I=
   ```

   The first command prints 44 characters of your own, different from these. The second asks
   `Enter a secret value:` and then prints:

   ```text
   ▲ [WARNING] Multiple environments are defined in the Wrangler configuration file, but no target environment was specified for the secret put command.
   ...
   🌀 Creating the secret for the Worker "gateweave-mail"
   ✨ Success! Uploaded secret SECRETS_KEY
   ```

   The warning is about Gateweave's own environments in `wrangler.jsonc`; the top level is the one
   you want, so ignore it.

   </details>

6. Open the address from step 4 in your browser. It opens the sign-in page, **Sign in to Gateweave
   Mail**. Choose **Create an account**, enter a name, an email address and a password of at least 8
   characters, then **Create account**. Mail sends no email unless you set it up, so it asks for no
   confirmation and any address will do.

   This server is open until you change it: anyone who reaches the address can make an account
   and a workspace of their own. Do this step before you share the address. To let in only people
   you choose, see [Closing sign-up](self-hosting.md#closing-sign-up).

   <details>
   <summary>Expected output</summary>

   You are signed in at once, and the page that opens is titled **Workspaces**, with "Signed in as"
   and your address under it, **Your account** and **Sign out** beside it, and "You are not in any
   workspace yet." below.

   </details>

7. Under **New workspace**, give it a name such as `Acme`, which fills **URL** with `acme`, and
   choose **Create workspace**.

   <details>
   <summary>Expected output</summary>

   The workspace opens on its own address, `/acme`, with its name as the heading and a section
   titled **No mailboxes yet**, which says that a mailbox gets its mail through addresses on a domain
   this workspace has proved. A sidebar with **Mailboxes** and **Settings** is beside it.

   </details>

8. Under **New mailbox**, type a name such as `Support` and choose **Make mailbox**. Leave "Everyone
   in the workspace can read it" unticked: you are the owner, and an owner reads every mailbox.

   <details>
   <summary>Expected output</summary>

   A card named **Support** appears under the form, with "No addresses yet." and, in place of an
   address form, "To give it an address, prove a domain first." The words "prove a domain" link to
   the next step's page.

   </details>

9. Choose **Settings** in the sidebar, which opens on the **Members** tab, then the **Domains** tab.
   Under **Domain name** type your domain, such as `example.com`, and choose **Add domain**. Each
   domain or subdomain is proved on its own: proving `example.com` gives no addresses on `mail.example.com`.

   <details>
   <summary>Expected output</summary>

   A row for the domain appears under **Domains**, marked "Waiting for proof", with "Add this TXT
   record to the domain's DNS:" and a Name and a Value under it:

   ```text
   Name   _gateweave-mail.example.com
   Value  gateweave-mail-verification=3f9c2a7e5b1d4c8a9e0f6b2d7a4c1e85
   ```

   The Value is 32 characters after the equals sign, and yours differs. Copy both from the page.

   </details>

<!-- timed run stops here -->

10. At your DNS host, add a TXT record with that name and that value. Some hosts want only
    `_gateweave-mail` as the name and add the domain themselves. Paste the value exactly, with no
    quotes of your own.

    <details>
    <summary>Expected output</summary>

    Your DNS host lists a TXT record named `_gateweave-mail.example.com`. A new record can take a few
    minutes to be seen. Mail shows nothing yet.

    </details>

11. Back on **Settings** › **Domains**, choose **Check DNS** on the domain's row. Mail asks
    Cloudflare's public DNS resolver, not your DNS host, so a record that is only just added may need
    another try after a few minutes.

    <details>
    <summary>Expected output</summary>

    While the record isn't seen, the row says "No matching TXT record yet. A new one can take a few
    minutes to show." and stays "Waiting for proof". Once it is seen, the row says **Proved**, with
    a collapsed **Its TXT record** that asks you to keep the record in DNS, and a line about mail:
    "Proved, but it has no MX records yet. Turning on Email Routing adds them." If the domain's mail
    already goes somewhere else, it says instead that not all its MX records point to Cloudflare.
    Both are fine here: this path doesn't receive mail.

    </details>

12. Choose **Mailboxes** in the sidebar. On the **Support** card, under **New address**, type
    `hello`, leave **At** on your domain and **How long** on "For good", and choose **Add address**.

    <details>
    <summary>Expected output</summary>

    The card lists `hello@example.com`, with a **Remove** button beside it, and "No addresses yet."
    is gone. The address exists in Mail's directory. Until Email Routing sends the domain's mail to
    the Worker, nothing arrives at it.

    </details>

## Next

- [self-hosting.md](self-hosting.md): receiving with Email Routing ("Getting a domain's mail to the
  Worker") and sending with Email Service ("Email"), then your own domain, sign-in providers and
  updating.
- [mcp.md](mcp.md): connect an AI agent to your Mail, with an agent's key from Settings › Agents.
