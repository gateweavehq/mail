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
  sent to. Suppressions that have ended go then too, and removed ones after 15 days.
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
  `setReject("No such address")`, for good. Mail for a known address is stored in its mailbox. When
  storing fails, or the database does, the handler throws, which tells the sender to try again:
  accepting a message we didn't keep would lose it. The Worker tests deliver to it through
  Miniflare (`test/inbound.test.ts`, `test/directory.test.ts`, `test/mailbox.test.ts`).
- **Resend's webhook** (`apps/web/src/server/resend-inbound.ts`), for a domain whose MX is
  Resend's, as a domain whose DNS isn't on this deployment's account can't use Email Routing. A
  domain is set to receive with Resend (`mail_domain.receives_with`, `cloudflare` by default) on
  the Domains page, which needs the workspace's Resend key with full access: Resend refuses a
  sending-only key received mail and webhooks. The first domain that receives or sends with Resend
  makes the workspace's webhook in that Resend account (`POST /webhooks`, for `email.received` and
  the delivery events below), at `/api/inbound/resend/<channel>`, a random id per workspace, and
  keeps its id and signing secret, sealed as the key is, in `resend_inbound`. When the last one
  stops, the row notes since when (`unused_since`) and the webhook stays fourteen days
  (`UNUSED_WEBHOOK_DAYS`), as Resend still tells of mail sent before, a complaint days later among
  it; then the daily run removes it, unless a domain uses Resend again. Sending doesn't wait for
  it: with a sending-only key a domain still sends, and Mail says it can't learn what became of
  the mail, or, when the webhook is made, that it can't check it. Putting in a new key, choosing
  Resend again, or "Check the webhook" on the Domains page makes it again when Resend no longer has
  it, as after the key was replaced with one from another account, turns it back on when Resend
  turned it off, and gives one made before Mail recorded deliveries the events it lacks. The
  webhook tells of everything the Resend account receives, so mail received while no domain of the
  workspace receives with Resend is let go without asking Resend for it.
  Resend's webhook carries no content, only the email's id. Mail checks the delivery's Svix
  signature, then asks Resend for the email (`GET /emails/receiving/<id>`) and takes its `to`.
  Resend keeps one email for each recipient of the envelope and names that one there, whatever the
  To header says; its `cc` is the Cc header and `received_for` is read from `Received` headers,
  which the sender writes, so neither counts, as a Bcc's copy keeps the other addresses in its
  headers. Mail keeps the address when it is on this workspace's proved domains that receive with
  Resend, downloads the raw mail from the signed address the answer gives, and stores it through
  the same path as `email()`, one copy for each mailbox. Resend took the mail already, so an
  address that doesn't exist can't be refused: it is left out. Mail answers 503 to anything that
  may work later (no key yet, a key Resend doesn't take or that can only send, an email the key's
  account doesn't have, Resend failing, a failed download, a full mailbox), and Resend tries
  again, eight times over about a day, before it turns the webhook off, so the workspace's last
  such trouble shows on the Domains page until mail is stored again. It answers 200 to what can't
  change: an answer of the wrong shape, or mail too large. Resend's answer holds the email's text
  and HTML, and Mail reads at most 16 MiB of it to keep within a Worker's memory, so a message
  with more text than that stays in Resend, even though raw mail up to 40 MiB streams into R2. A
  retry is stored once, as in `email()`. The Worker tests stand in for Resend's API and its
  downloads (`test/resend-inbound.test.ts`).
- **Mailboxes** (`apps/web/src/server/mailbox/`). Each mailbox has a `Mailbox` Durable Object,
  named by the mailbox's id, that holds the index of its messages in SQLite. The raw mail is in R2,
  one object per message under `<workspace>/<mailbox>/`. `email()` reads the header block and
  streams the whole message into R2 without holding it, which fits in its CPU. Nothing is parsed
  on arrival.
  - **R2 holds nothing the mailbox doesn't know about.** The object names each message before it
    is written, as pending, and an alarm removes a delivery that hasn't finished 15 minutes later,
    with whatever part of it reached R2. The alarm marks such a delivery expired before it
    deletes anything, so one that finishes late finds it gone, deletes its own mail and is tried
    again. So removing a mailbox's prefix removes all of its mail.
  - **The same message twice is kept once.** A delivery's key is a hash of the mailbox and
    whichever of the message's `Message-ID`, `From`, `Date` and `Subject` it has. When one
    finishes and a stored message has the same key, their bodies are compared, and the copy goes
    only if they match: someone who guessed a message's headers can't get it dropped. The copy's
    mail goes before its row, so a failure leaves it pending for the alarm.
  - **A mailbox holds up to 1 GiB**, or `MAILBOX_BYTES`. Its object keeps the total in a row of its
    own, which triggers update as messages come and go, so a delivery doesn't add them up. Past the
    limit, a message gets a temporary refusal, so it arrives if room is made before the sender
    gives up. Owners and admins can delete a message, which frees its space.
  - **Threads.** A message joins a thread when it is stored, if it names a stored message of the
    mailbox in `In-Reply-To` or `References`, a stored message names it, or the two name the same
    message, which the mailbox may never have got (mail its people sent from elsewhere), **and**
    their subjects are the same once `Re:`, `Fwd:`, list tags and their kin are off. A subject
    alone never joins a thread, as anyone can write one. A reply that arrives before the message it
    answers is taken in when that message comes, and a message that links threads merges them into
    the one that began first. The query that finds them has the same few values however many
    threads a message links, as SQLite takes at most a hundred. `References` is read from its end,
    keeping the newest 50 ids. Someone who knows a message's id and subject can still add to its
    thread, as in any mail program; their message shows under its own sender, proved or not. So a
    thread's line shows its newest message's subject, which the proved domain beside it speaks for,
    and without `Re:`, list tags and their kin, with look-alike forms such as full-width brackets
    made plain: those are all that may differ between a thread's subjects, so no sender's own
    words reach the line. The query that finds a message's threads keeps SQLite off the index on
    `state`, which would read every stored message. A `thread` row keeps the count and the first
    and newest arrival, so a page of threads is one indexed read; the object brings it up to date as messages are stored and deleted. The
    object's schema has versions, kept in a table, since Durable Objects have no
    `PRAGMA user_version` (`schema.ts`); messages stored before threads became a thread each, and
    so does any message stored without one, as code from before threads would after a rollback.
  - **Reading.** A mailbox's page lists its threads, newest news first, and a thread's page shows
    its messages oldest first, 50 at a time from the newest, with the newest open. The same are at
    `/api/mail/<workspace>/<mailbox>/threads` and `…/threads/<thread>`, beside the messages, newest
    first, at `/api/mail/<workspace>/<mailbox>`. A message is parsed with postal-mime when someone
    opens it. The original downloads from `/api/mail/<workspace>/<mailbox>/<message>/original`, as
    a file, never as a page. Who reads it is decided per mailbox (below). Anyone else, a
    non-member, or a mailbox of another workspace, gets the same "not found" as a missing one, and
    the mailbox is checked against the caller's workspace in D1 before its object is asked
    anything.
  - **Who reads a mailbox.** Owners and admins read every one. Anyone else reads one they were
    given (`mailbox_access`, a row per membership and mailbox), or one open to everyone
    (`mailbox.everyone`) when they are a person: an agent counts only with a grant of its own, and
    so does a role this version doesn't know, which `toRole` reads as an agent's. `canReadMailbox`
    in `lib/roles.ts` is the rule and `openMailbox` in
    `read.ts`, which every route to mail goes through, the one place it is applied; the directory
    lists only the mailboxes the caller can read. A grant belongs to the membership, not the
    person, so it goes when they leave and doesn't come back if they join again. Triggers refuse
    one whose member and mailbox are in different workspaces (`0007_mailbox_access_rules.sql`).
    A new mailbox is for owners and admins until one of them opens it to everyone or gives it to
    people; the mailboxes there were before this rule stayed open to everyone.
  - **Agents** (`server/auth/agents.ts`, ported from Track). An admin makes an agent on the
    workspace's Agents page: a user with the `agent` role in that one workspace, an address under
    `agents.invalid` that nobody can sign up, sign in or be invited with, and no password or
    session. It reads with a key, `gwm_` and 256 random bits, of which only a SHA-256 hash and the
    first characters are kept, sent as `Authorization: Bearer`. `currentCaller` in `access.ts`
    takes a request with a bearer token as the agent's alone: a key that doesn't work, or works
    for another workspace, gets "not found", and the cookies that came with it are never tried
    instead. Another scheme, such as Basic auth from a proxy in front of the app, carries no key,
    so the session decides. Reading takes a caller (`openMailbox`, and listing the directory,
    which shows an agent the mailboxes it was given), and so does sending, where a key may only
    send, as below; every other change takes `currentMember`, a person signed in. Making an agent
    or a key, or changing its sending policy, takes a sign-in from the last day, since each
    outlives the session that made it. Letting it send from a mailbox is a change to the mailbox's
    access, as giving it the mailbox to read is. The plugin manages only accounts it made, under `agents.invalid`:
    a person who was given the `agent` role by hand is never listed, keyed or deleted as one.
    Agents are kept off the members page and out of Better Auth's role and removal endpoints;
    deleting one, from its own page, takes its keys and grants, and a deleted workspace takes its
    agents.
  - **HTML.** A message's HTML is a page of its own, at `…/<message>/html`, which the message's
    page shows in a frame; its text, or the text made from its HTML, is a click away. What makes
    it safe is the policy it is served with (`framePolicy` in `html.ts`): `sandbox` without
    `allow-scripts` or `allow-same-origin`, so nothing runs and the page has an opaque origin
    that can't read the app's cookies or reach its pages, even when opened on its own;
    `default-src 'none'`, so it loads nothing from elsewhere; and links that may only open a
    tab of their own. An opaque origin gives what a second hostname would, without every
    deployment having to set one up. Remote images load only when the reader asks, for that
    view, since loading them tells the sender the message was opened. HTMLRewriter cleans the
    HTML as well: it keeps known tags and attributes, drops scripts, frames, forms' controls,
    `meta`, `base` and `link` with what they hold, opens links in a new tab without a referrer,
    and puts the message's own `cid:` images in as `data:` addresses (PNG, JPEG, GIF and WebP,
    5 MB at most). The cleaning is a second layer: the policy holds even where it misses
    something. The first 1,000,000 characters of the HTML show, and the app says when there is
    more; nothing is added to the page after the message's own HTML, since a tag the cut left
    open would take it in. Inline images count at every use, so naming one many times can't
    make the page huge. A frame that runs nothing can't say how tall it is, so the frame has a
    height of its own, which the reader can drag. The app's own policy allows frames from itself
    only.
  - **Search.** A mailbox's page, and `…/threads?q=`, list the threads with a message that has
    every word typed, newest news first. The last word also finds the words it starts, when it
    ends in two letters or digits or more (FTS5 takes the prefix from its last token, so `a.` is
    `a`): one starts so many that a big mailbox would read most of its index.
    An FTS5 table in the mailbox's object indexes each message's subject, sender, attachment names
    and text, with accents set aside. Both the index and a query make look-alike forms plain
    (NFKC: full-width letters and digits, half-width katakana, ligatures), so either side may be
    written in them. Each word is quoted, so what FTS5 would read as syntax (`OR`, `NEAR`,
    `column:`, `*`) is only text, and control characters part words, as FTS5 would end a quoted
    word at a NUL. At most 10 words of the first 200 characters count. The tokenizer
    (`unicode61`) takes a run of Chinese or Japanese characters as one word, so a search finds such
    text by the start of a run only; a trigram index would find any part, at a larger size.
    The object's alarm indexes messages a second after they are stored, 20 at a time and the
    newest first, so a delivery never waits for its mail to be parsed and new mail is found soon
    even while older mail waits, as after an upgrade. It reads a message's first 2 MiB from R2 and
    indexes up to 100,000 characters of its text, or of its HTML made text, 10,000 of its
    attachments' names and 1,000 each of its subject and sender, counted once made plain, as NFKC
    can make one character eighteen. A message postal-mime can't parse is found by its subject and
    sender. A message whose mail R2 fails to give is tried again later while the rest are indexed,
    and when none of a run's could be read, indexing waits a minute. An entry that still can't be
    written is written with the headers only, or empty. So nothing a message holds makes the alarm,
    which also expires deliveries, fail. The table is contentless: it holds
    the words' places, not the mail, and a trigger takes a message's entry out with the message.
    Messages stored before search are indexed when their object next starts. A search is in its
    page's URL, so it can be shared and reloaded; Workers Logs, when on, keep URLs, and so what
    members searched for, as long as they keep logs.
  - **Who sent it.** A message shows as from a domain only when Cloudflare's own
    `Authentication-Results` says `dmarc=pass` for that domain (`header.from`), and the message
    has one `From` holding one address on it. Cloudflare adds its headers at the top, below its
    own `Received` line, each once and in one order, so only a verdict among them counts. A field
    out of that order, and everything below it, came with the message. Comments in the verdict are
    skipped, as they quote the envelope sender, and a verdict that names DMARC twice isn't trusted.
    A field whose name only looks like `From`, such as `From :`, counts as a second one. Pages
    show the proved domain beside the mark: the name in front of the address is the sender's to
    write. Mail that came through Resend has no such headers of Cloudflare's, and any it has are
    the sender's: its verdict is the DMARC result Resend's API gives, which its MX computed, for
    the domain of the one address in the one `From`.
  - **Sending** (`send.ts`, `compose.ts`, `delivery.ts`). A person who may read a mailbox replies
    to its mail and writes new mail from it, at `POST /api/mail/<workspace>/<mailbox>/outbox`,
    signed in and from the app's own origin. An agent sends there with its key, as below. A
    message goes from one of the
    mailbox's addresses on a proved domain that hasn't run out (`senders.ts`): the one chosen, or
    for a reply the one the answered message came to, or else the oldest. It goes through the
    `EMAIL` binding of Cloudflare Email Service, which sends only from a domain onboarded for
    Email Sending. It is plain text for now, to at most 20 people, To and Cc together, with a
    subject that has no line break. A workspace sends at most 200 messages a day (`SEND_PER_DAY`),
    counted by the rate-limit object, besides Email Service's own limits.
    - **Its copy is in the mailbox before it goes.** The object takes the message as Mail wrote it,
      as an RFC 5322 copy for R2 named pending first as arriving mail is, with an `outgoing` row,
      in one transaction, and only then calls the binding. So the copy is in its thread at once,
      says who wrote it (`message.sent_by`, a membership), and counts toward the mailbox's size; a
      full mailbox doesn't send.
    - **Its own id keeps the thread.** Email Service makes the `Message-ID` and refuses one from
      the sender, and nothing says the id it returns is the header's. So Mail gives each message an
      id of its own, `<uuid@domain>`, puts it last in `References`, and keeps it as the copy's own:
      a reply to the message names it, and joins the thread, whatever id the message went out
      with. A reply takes `In-Reply-To` and `References` from the answered message's own headers:
      its `References`, or failing those its `In-Reply-To`, then its id. A long chain keeps the
      first id and the newest that fit in Email Service's 2,048 bytes for a header.
    - **An agent's mail waits for a person** (`agent-policy.ts`). A key may only send, never
      approve, reject, send again or discard, and only from a mailbox whose grant to the agent says
      so (`mailbox_access.send`, which only an agent's grant can have, as a person who reads a
      mailbox sends anyway). Its policy (`agent_policy`, set by an owner or admin on the Agents
      page) gives it a day's count, 20 unless changed and 0 to stop it, counted as it writes,
      whether the message waits or not (`agent-send:<member>` in the rate-limit object), and a
      list of addresses and domains (`@example.com`, not its subdomains) it may mail on its own.
      A message to anyone else, To or Cc, is kept as `held`: its copy is in its thread like any
      other, Email Service isn't called, and the mailbox's page lists what waits. Anyone who may
      read the mailbox can approve it, which sends it then and records who did
      (`outgoing.approved_by`), or reject it, which discards it; rejecting doesn't need the right
      to discard others' mail, but only for a message still held, which the object checks again
      as it marks it. The workspace's day counts a message when it goes: a held one when it is
      approved, once the gateway has seen it still waits. A changed policy doesn't start the
      agent's day again (the limiter keeps a named rule's use when its number changes). Only a
      key is an agent here: agents never sign in, so a session is a person's, whatever its role.
    - **Resend, for a domain elsewhere** (`providers/`). Email Service sends only from domains on
      this deployment's account, so a domain can be set to send through Resend instead
      (`mail_domain.sends_with`, `cloudflare` by default), with the workspace's own Resend key. An
      owner or admin adds the key on the Domains page. Adding or replacing it takes a recent
      sign-in, and Resend is asked first whether it takes it (`GET /domains`, which a full-access
      key may call and a sending-only key is refused as restricted: both are real). The key is kept
      in `provider_key`, sealed with AES-256-GCM under a key that HKDF derives from `SECRETS_KEY`
      and the workspace's id, with its place as additional data (`secrets.ts`, as Agents seals its
      keys). No page gets it back, only its last four characters, and without `SECRETS_KEY` no key
      can be added. A domain can be set to Resend only while the workspace has a key, and a message
      from it is refused when it is written if the key has gone since, before anything is counted.
      Each message keeps the way it was written with (`outgoing.provider`), and the object reads and
      opens the key from D1 at each try, so one replaced or removed meanwhile is the one that
      counts. Resend gets the same message the binding would, with Mail's own id in `References`
      as before, and the message's id as `Idempotency-Key`, which Resend keeps for a day: a repeat
      gets the first answer and sends nothing. So, unlike Email Service's, a Resend try that may
      have gone (its own failure, a timeout, the same key still in progress, or a try the alarm
      finds still `sending`) is tried again on the busy waits, and is `uncertain` only when they
      run out. A refusal keeps Resend's own words (`outgoing.detail`) for the page, and spends the
      key, as Resend would only refuse it again: the next try, after a fix, gets a new one. Not
      after a try that may have gone (`outgoing.maybe_sent`), though: Resend checks the API key
      before it looks for what the idempotency key sent, so a refusal then doesn't say that try
      didn't go. The message keeps its key and ends `uncertain`, as it does when its tries run out
      or its key is gone. Resend also knows an idempotency key only in the account that sent it,
      so each try notes which saving of the workspace's key it used (`outgoing.key_version`, a
      digest of the sealed value), and after a try that may have gone, a different one stops it
      as `uncertain` (`resend:key_changed`). Someone who then sends it again takes the new key.
    - **States** (`outgoing.state`). `held` for an agent's message that waits for approval, as
      above. `sending`, then `sent`. `waiting` when Email Service is busy
      (its rate or daily limit): the object's alarm tries again after 15 seconds, 1, 5 and 30
      minutes and 2 hours, or 1, 3, 6 and 12 hours for the daily limit, and then takes it as
      refused. `refused` with Email Service's code, which the page says in words. `uncertain` when
      the call failed without a code or with Email Service's own failure, which may come after it
      took the message, or when the alarm finds a try still `sending` 10 minutes on, as when the
      isolate went away: it may have gone. A message whose first try never began, which the alarm
      also finds then, sent nothing and waits to be tried. Email Service has no idempotency key,
      so an uncertain message is never sent again by itself; a person sends a refused or uncertain
      one again, or discards it, which takes its copy out of the mailbox. Only who wrote it, or an
      owner or admin, discards it. Each change of state is made only from the state it was found
      in, in the same statement, so a message discarded or deleted while the alarm works through
      its list isn't sent. Deleting a message that isn't sent first makes it `discarded`, which no
      try starts from, before its copy's mail is deleted from R2: neither the alarm nor a Send
      again in another tab can send it meanwhile. Should that delete fail, the copy stays,
      discarded, and can be discarded again.
    - **A draft is sent once.** The page gives each draft an id when it opens, kept in `outgoing`.
      A send with an id the mailbox has seen answers with that message's state and sends nothing,
      so a person whose answer was lost, by the network or a deploy, can press Send again. The
      gateway asks before counting the send against the day's limit, so that doesn't refuse it,
      and the page keeps the message as it was until then, since a change would not be sent.
    - **Threading the copy.** Ids that aren't printable ASCII, which some senders use, stay out of
      the headers sent, as Email Service would refuse them, but the copy is still put in the thread
      of every id the reply answers.
    - **Delivery events** (`apps/web/src/server/delivery-events.ts`). Sending ends when Email
      Service takes a message, and what each recipient's server then does comes later, as events
      (`cf.email.sending.message.{delivered,deferred,bounced,failed,rejected,complained}`) that a
      subscription per sending domain publishes to the deployment's queue
      (`gateweave-mail-events`), whose consumer is the Worker's `queue()`. An event names the
      message by the id `send()` gave, which the object kept as `outgoing.provider_id` (measured on
      staging on 2026-11-08: the same string, angle brackets included), and the mailbox by the
      address it was sent from: the directory gives the mailbox of that address on a proved domain,
      which must also be the domain whose subscription sent the event. Nothing is written when a
      message is sent beyond what was, and there is nothing to prune. The object keeps one
      `delivery` row per recipient, which an event replaces only when its state ranks higher
      (`DELIVERY_RANK`: delayed, then delivered, then bounced, failed or rejected, then marked as
      spam) or ranks the same and is newer, with the state and then the server's words breaking a
      tie, so events that come twice or in any order end the same. The thread shows them under the
      message, and the worst trouble (a bounce, a failure, a refusal or a complaint) on its line,
      with how many recipients it hit when there were several. An event for an address that isn't
      a mailbox's, such as another app's from the same domain, is dropped; one whose message isn't
      found is looked for again for ten minutes from the event, then dropped, as for a message
      deleted since. When D1 or the object fails, the events come again later, waiting twice as
      long each time up to twelve hours, so they outlast an outage of up to about three days, or of
      the queue's retention when that is shorter (24 hours on Workers Free). Every event that reads
      as Email Sending's notes when its domain's events last came (`mail_domain.events_at`), which
      the Domains page shows admins, so a missing subscription shows. The handler logs counts and
      what failed, never addresses. A new subscription took a few minutes to start publishing on
      staging.
    - **Resend's delivery events** (`apps/web/src/server/resend-events.ts`). Mail sent through
      Resend is told of by the workspace's webhook, as `email.delivered`, `email.delivery_delayed`,
      `email.bounced`, `email.complained`, `email.failed` and `email.suppressed`, read into the same
      states and `delivery` rows. Measured on 2026-11-09 with Resend's test addresses: an event for
      each recipient, Cc too, naming only that one in `to`; the message by `email_id`, the id
      Resend gave when it took it, which the object kept; a complaint followed by a `delivered`;
      and an address on Resend's list left out with `email.suppressed` while the others were sent
      to, where Email Service refuses the whole message. Its signature is checked as for received
      mail, then the event is read with zod, and it counts only when its `from` is an address of a
      mailbox of the webhook's own workspace, on a proved domain, as the key's Resend account may
      send for others too. It notes when that domain's events last came, for that workspace only
      and while the domain still sends with Resend. A domain that changes how it sends forgets the
      time, as those were the other provider's events, and the other's late events don't set it. An
      event Mail can't read, as one with an odd `email_id`, is acknowledged. Mail
      answers 503 to an event whose message isn't found yet, for ten minutes from the event, and
      when D1 or the object fails, so Resend tries again; it answers with a success to anything
      else, as Resend turns off a webhook that keeps failing.
    - **Suppressions** (`apps/web/src/server/suppressions/`). Each workspace keeps the addresses its
      mailboxes won't send to, in D1 (`mail_suppression`, one row per address), for the workspace
      of the mailbox that sent. What goes on follows Email Service's rules (`suppressionOf`):
      - a complaint stays until someone removes it;
      - a hard bounce stays for good when the server's enhanced code says the mailbox or domain
        doesn't exist (`5.1.1`, `5.1.2`, `5.1.3` or `5.1.10`, from the event's own code or the
        start of the reply), otherwise seven days (`SUPPRESSION_DAYS`);
      - a refusal because Email Service's list has the address stays seven days.

      Resend's events follow the same rules: a complaint; a bounce whose `type` is `Permanent`,
      for good by the code its first reply starts with, after Resend's `smtp; `; and
      `email.suppressed`, or a bounce of the subtype `Suppressed`, as the provider's list for seven
      days. Resend sends to the other recipients of such a message, so the entry is what stops the
      next one. Resend gives the message its id before it leaves an address out, so each of these
      counts only for a message the mailbox has.

      A soft bounce, a delay or another failure adds nothing. A bounce or a complaint counts only
      for a message the mailbox has, so one about mail from before a domain changed workspaces
      can't stop the new one's. So one about a sent message deleted before it came adds nothing;
      Email Service's own list still refuses the next send, and that refusal puts the address on.
      A refusal counts either way, as Email Service gives a message it
      refuses no id; measured on staging (2026-11-09), it publishes one event for a refused
      message of two recipients. Email Service keeps its entries per sending domain; Mail's apply
      to every domain of the workspace, as a person who complained about one of its mailboxes wants
      none of them. A second event keeps the stronger reason (`SUPPRESSION_RANK`), the later end
      and, for the same reason, the newer words, or starts afresh once the entry has ended, in one
      upsert, so events in any order end the same. An event whose entry would already have ended
      adds nothing. The mailboxes record a batch first, then the lists are written; when they
      can't be, those events come again, and recording them twice changes nothing.

      The outbox checks the list before it stores anything: on a send, after the draft's id is
      looked up, so a send already made still answers; on an approval; and on Send again. A
      person's send is checked before anything is counted; an agent's after its own day counts it,
      so a key can't learn who is on the list for free. It refuses with 409, naming the addresses,
      with the reasons only for owners and admins, and the page keeps the draft as it was. A
      message that waits to be tried again (`waiting`) is checked again by its object, which stops
      it as `refused` with `mail:suppressed`. Only owners and admins see the list, in Settings ›
      Suppressions, as it names people the workspace wrote to, and they can remove an entry there.
      A removed entry is kept, hidden, for 15 days (`REMOVED_KEPT_DAYS`, longer than a queue keeps
      a message), so that an event from before the removal, which a queue may hand over again,
      doesn't put it back. Search uses `instr`, as D1 refuses a `LIKE` pattern over 50 bytes.

      Removing also asks the providers' own lists, which would still refuse the address
      (`suppressions/providers.ts`), and the page says what each did. Resend's, with the
      workspace's key, while one of its domains sends with Resend, as that list holds for the key's
      whole account: `DELETE /suppressions/{address}`, measured on 2026-11-09 to answer 200 when it
      was listed, 404 `not_found` when it wasn't, and 401 `restricted_api_key` for a sending-only
      key either way. Email Service's, while one sends with it, and only with the deployment's
      optional `EMAIL_SENDING_ACCOUNT_ID` and `EMAIL_SENDING_API_TOKEN`
      (`providers/email-sending.ts`). That list is the account's, which every workspace's domains
      share, so Mail deletes only an entry for one of this workspace's proved domains (scope
      `sending_domain`, which matches that exact domain only) that Cloudflare made from delivery
      (`complaint`, `hard_bounce` or `soft_bounce`) and doesn't mark `read_only`. An entry for the
      whole account, one added by hand (`manual`), Cloudflare's own (`policy`), read-only ones, and
      any Mail can't read or whose scope it doesn't know stay, counted for the page; other domains'
      entries aren't mentioned. Measured on 2026-11-09: the `email` filter matches the whole
      address, ignoring case, and refuses anything else with 400; a DELETE answers 200, then 404.
      The account also had entries for the whole account made by hard bounces, which Mail keeps,
      as they stop every sender on the account. The domains are read before the entry comes off,
      and both providers are asked at once. What a provider answers never undoes Mail's removal,
      and the log names what failed, never the address.

      Resend's `suppression.removed`, which the webhook asks for, says someone took the address off
      Resend's list, as in its dashboard. Every webhook of the account hears of its list, which the
      account's other senders share, so it counts only when the email that put the address there
      (`source_id`) was sent from this workspace's mailbox, as Resend's API says with the
      workspace's key; one put there by hand names no email, and one whose sender Mail can't learn
      changes nothing. Mail then notes it as a removal of an entry Resend's events made, at the
      event's time, or now when Resend's clock runs ahead: the entry comes off unless an event said
      it since, and one from before, which may still come, counts as older than the removal, as
      after an admin's. With no entry yet, a hidden removed one is kept for the event still to
      come. A later removal noted already stays. Mail's own removal comes back as one too, which
      only moves its time on to Resend's. An entry's provider is the last event's, so a removal at
      Resend can take off an entry Email Service's events also said; Email Service's list still
      refuses the address then, which puts it back. `suppression.added` isn't mirrored, as
      Resend's delivery events already put those addresses on.
  - **Removing.** Removing a mailbox, or deleting its workspace, removes its mail and its object's
    data, after the directory has forgotten its addresses, so nothing new arrives. A trigger in D1
    records each mailbox as its row goes, a workspace's by cascade too (`mailbox_removal`). The
    daily run removes the mail again an hour or more after, then forgets the record: that finishes
    a removal that stopped part way, and catches a delivery that found the mailbox just before it
    went. Only removed mailboxes' prefixes are touched, so the bucket can hold other things.

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
- **D1 for accounts and the address directory**, a Durable Object per mailbox and R2 for raw mail,
  as above.
- **Remote images per sender**, remembered for those the reader trusts, where now they are asked
  for each time.
- **Addresses and aliases an agent can make for itself.**
- **Writing more than plain text**: formatting, attachments, forwarding and replying to all.

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
- **Cloudflare adds its headers at the top,** in this order: `Received` (`by cloudflare-email.net`),
  `ARC-Seal`, `ARC-Message-Signature`, `ARC-Authentication-Results`, `Received-SPF`,
  `Authentication-Results` (`mx.cloudflare.net`), then `X-CF-SpamH-Score`. The sender's own headers
  follow, and they can include an `Authentication-Results` of their own.
- **`message.headers.get()` joins a repeated header with ", "**, so it can't tell Cloudflare's
  `Authentication-Results` from a sender's. Mail reads the header block from the raw message
  instead.
