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
  sent to. Suppressions that have ended go then too, and removed ones after 15 days, and an
  agent's log after 90 days.
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
  hand, after a confirmation, frees the name for people at once, since a person chose that, but
  not for agents (below). Pages read the
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
  - **Raw mail is sealed in R2** (`sealed.ts`), when the deployment has a `SECRETS_KEY`. Each
    object has its own AES-256-GCM key, which HKDF derives from `SECRETS_KEY`, a random salt kept
    in the message's row (`message.seal`), and the object's name, which holds the workspace's and
    mailbox's ids: the bucket alone opens nothing, and an object put back from another message, or
    moved to another name, doesn't open. The mail is sealed in 64 KiB chunks, each with its own
    tag, so it streams in and out and a part of it is read from only the chunks that hold it, as
    search reads a message's start. A chunk's nonce is its place and the last one is marked last
    in its additional data, and the object must be exactly as long as the row's size makes it, so
    nothing can be reordered, cut or added. Everything reads and writes raw mail through
    `RawMail`, and mail with no seal, kept before sealing or without a `SECRETS_KEY`, is read as it
    is. A seal (`v2.<key id>.<salt>`) names the key it was made with (`secrets-key.ts`: a keyed
    digest of the key, which says nothing of it), so mail under the key before the current one
    opens with `SECRETS_KEY_PREVIOUS`, and one under a key the server doesn't have fails at once.
    A seal from before keys had ids (`v1.<salt>`) is opened with the current key, then the
    previous, reading the object again for the second. New mail is sealed only under the current
    key, which its seal must name.
    - **Versions side by side.** The Worker picks the seal and the object keeps it (`begin`), and
      the mail is sealed only with the seal the object gave back, so a Worker and an object of
      different versions during a deploy never write mail its row can't read. A row from an
      object older than sealing has no `seal` at all, which reads as none. Code older than sealing
      reads sealed mail as if it were plain, so it shows garbled there, and code older than key
      ids finds a `v2` seal of no kind it knows and marks the mail as not opening: roll back only
      to a version that reads the seals written since.
    - **Mail that doesn't open** (`SealError`): `unopened` when it was changed or moved, or
      neither `SECRETS_KEY` nor `SECRETS_KEY_PREVIOUS` is the one it was sealed with, which trying
      again won't mend; `no-key` when
      the server has none, which setting one may. The first chunk is opened before anything is
      returned, so a download fails before it starts rather than part way. Its thread still shows,
      without it opened; the message, its HTML and its original answer 500 and say it can't be
      opened; a reply to it is threaded by the id in its row; search finds it by its headers, or
      tries again for `no-key`; and a copy whose files are waiting is refused as
      `mail:copy_unread`, or left uncertain when a try may have gone, or tried again for `no-key`.
    - **Mail kept as it came is sealed later** (`resealing.ts`), once the deployment has a usable
      `SECRETS_KEY`: from the mailbox object's alarm, which runs this last so the deliveries,
      sends and indexing it also does never wait behind it. Each run takes at most 5 stored
      messages, the newest first, and stops short of 32 MiB of mail (by the rows' sizes; a message
      over that alone is still taken, by itself): mail streams through, so memory stays flat, and
      a run is a few seconds of R2 and AES-GCM at most. It sets the alarm again while some remain.
      A mailbox seals its old mail as it wakes: the object looks when it starts, which any mail,
      read, alarm or the daily run asking does, so a mailbox nobody uses keeps its old mail as it
      came until then. A message's sealed copy is
      written under its own name with `.sealed` before `.eml` (so under the mailbox's prefix, and
      known to the mailbox without an entry of its own: `deletePrefix`, deleting a message and
      removing a mailbox all cover it), and opened at its start. Then, in one synchronous step,
      the row takes the copy's name and seal and keeps the original's name in `stale_object`, with
      when in `stale_at`. The original is kept for a grace window of `PENDING_MS` (15 minutes), so
      a page or an `.eml` download that read the row just before the switch still finds its
      object; the alarm then deletes it and forgets the name, setting itself for the earliest
      one still waiting. A stop at any point leaves a row that names an object that opens, and at
      worst an original a later run deletes. Deleting the message or removing the mailbox deletes
      a stale original at once. A message
      deleted, sealed or begun to be sent while its copy was written is left as it is, and the
      copy deleted; a message deleted while the object switches it has its copy deleted too
      (`remove` reads the row again after deleting). A mailbox removed meanwhile has the
      copy deleted by the run, or by the prefix delete the daily run repeats. A message being
      tried right now is left for a later run; one waiting to be sent, approved or sent again is
      sealed like the rest, as it may wait for good, and each try reads its copy through the row.
      Pending messages are not stored yet and are never touched. Mail that is
      missing from R2, or isn't the size its row says, gets `seal_failed_at` and is not tried
      again: nothing clears it, as trying again won't mend it, and the message reads as it did
      (to try it again, set the column to NULL in the object's storage). A failure of R2 itself
      is counted per message (`seal_tries`) and tried again after a minute; the fifth marks it as
      mail that doesn't open, with a log line that names only the kind of error. Search and the duplicate check (`body_hash`) work on the
      plaintext and are unaffected.
    - **Mail under the previous key is sealed again** the same way, from the same run, once mail
      kept as it came has had its turn: with `SECRETS_KEY_PREVIOUS` set, rows whose seal names it,
      or names no key (`v1`), found as ranges of `message_sealed`. The copy is named with the
      message's id and the current key's (`<id>.<key id>.eml`), so each change of key writes a name
      of its own, which deleting the message also covers for the current and previous keys. A
      message whose original still waits out its window is left until it is deleted. Mail that
      opens with neither key, or is missing, gets `rekey_failed`, the previous key's id, so that
      another `SECRETS_KEY_PREVIOUS` has it tried again (a switch clears it); R2 failing five
      times stops tries until the daily run next asks. Without a previous key, sealed mail is left as it is.
    - **The daily run asks mailboxes** (`resealMailboxes`) while the deployment has a previous
      key: up to 200 a run, at random among those D1 doesn't know are done
      (`mailbox.sealed_under`: the current and previous keys' ids, `keysDone`, once a mailbox said
      it had none left, so another previous key has them all asked again). Asking
      (`resealStatus`) counts what is still under the previous key, deliveries on their way under
      another key included, and what opens with neither; it resets R2's tries and sets the alarm,
      so a mailbox nobody uses gets its turn too. A mailbox that stores a delivery a Worker sealed
      under another key, as during a deploy, sets its `sealed_under` back to NULL. The run logs
      `raw mail:` with the counts, which, with `secrets:`, say when the previous key can go. An
      object's start doesn't look for this work, so a wake costs nothing more.
    - Sealed mail stays as it was written, so another scheme would be a new seal version beside
      `v1` and `v2`.
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
    a file, never as a page, and so does each attachment on its own, from
    `…/<message>/attachments/<n>`, its place among the message's attachments from 0
    (`server/mailbox/download.ts`). A sender chooses a file's bytes, name and type, so it always
    goes as `attachment` under its name as RFC 6266 has it (in UTF-8, beside an ASCII one), with
    `nosniff` and a policy of its own, `default-src 'none'; sandbox`. Its stated type goes with it
    only when no browser runs that type (images, PDF, plain text, office files and the like), and
    anything else, HTML and SVG among them, as `application/octet-stream`. Its name loses what
    would make it a path, a hidden file or a control, and the marks that turn text around, which
    could make `invoice[RLO]fdp.exe` look like a PDF (`lib/file-names.ts`), and the page shows each file by that name, as it will be saved. Nothing previews on Mail's origin. An agent's `get_attachment` gives the same file, by the same name, in Base64, up to 5 MB: an MCP answer carries it twice. Who reads it is decided per mailbox (below). Anyone else, a
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
    takes a request with a bearer token in that shape as the agent's alone: a key that doesn't
    work, or works for another workspace, gets "not found", and the cookies that came with it are
    never tried instead. Another bearer token or scheme, such as an ID token or Basic auth from a
    proxy in front of the app, carries no key, so the session decides. Only the role on an
    `agents.invalid` address makes a member an agent (`isAgentMember`): a person given the role by
    hand in the database is listed among the people and can be removed, and reads and sends no
    more than an agent may. Reading takes a caller (`openMailbox`, and listing the directory,
    which shows an agent the mailboxes it was given), and so does sending, where a key may only
    send, as below, and so do the addresses an agent makes for itself; every other change takes
    `currentMember`, a person signed in. Making an agent
    or a key, or changing its sending policy, takes a sign-in from the last day, since each
    outlives the session that made it. Letting it send from a mailbox is a change to the mailbox's
    access, as giving it the mailbox to read is. The plugin manages only accounts it made, under `agents.invalid`:
    a person who was given the `agent` role by hand is never listed, keyed or deleted as one.
    Agents are kept off the members page and out of Better Auth's role and removal endpoints;
    deleting one, from its own page, takes its keys and grants, and a deleted workspace takes its
    agents.
  - **Pausing an agent** stops it and keeps everything it has, for when it does what it
    shouldn't. An owner or admin pauses it on the Agents page, which shows who did it and when
    (`agent_pause`, keyed by membership). While it is paused, `findAgentByKey` answers that it is,
    so its keys do nothing anywhere: the MCP server and the agent API answer 403 with "This agent
    is paused…", and the app's own routes know the key no more than a revoked one. A request it
    began before is told the same once it next asks, and a send asks again just before the
    message goes, after reading and cleaning it; mail a provider already took is out of reach.
    What it wrote that waits to be tried again goes to a person instead: the mailbox's alarm asks
    D1 which of the writers of what is due are paused, or no longer members, as an agent deleted
    while paused takes its pause with it, and holds their mail for approval (`message.held`).
    Mail a person approved is theirs and goes on. When D1 doesn't answer, the alarm puts all of it
    off a minute rather than send what a paused agent wrote. Mail already held stays held, and
    people may still approve or reject it. Its own webhooks hear nothing while it is paused, and a
    retry that comes due fails ("The agent was paused."), within the ten seconds the webhooks
    object trusts what D1 last said. Mail to its addresses still arrives in the mailbox for people to read. Pausing
    needs no recent sign-in, so it is quick; resuming, which gives its keys back, does, as making
    a key does.
  - **An agent's page** (`server/mailbox/agent-activity.ts`; its name on the Agents page opens
    it, and `/api/agents/<workspace>/<agent>` gives the same as JSON) shows an owner or admin what
    it may do and holds, and what it did, newest first: what it wrote (`message.sent_by`), what of
    that waits for approval, and what came to the addresses it made. The last is
    `message.came_for` (schema version 11), the agent's membership when the address the mail
    arrived at is one it made, noted on arrival by Email Routing or Resend from
    `mail_address.agent_member_id`. It stays when the address ends or is removed; mail that
    arrived before it was noted has none, and mail to a mailbox's own addresses isn't the agent's.
    Email Routing hands each recipient its own copy, and the mailbox keeps one: a later copy,
    proved as the kept one was, adds its address to the kept one's `envelope_to`, and its agent
    when the kept one has none, so mail to a mailbox's address and an agent's is the agent's, and
    an agent waiting for mail to its address finds it (`copies.ts`). A copy counts when it comes
    within the hour, or at any time when its sender is proved to have addressed it there
    (`message.addressed`, schema version 17): Cloudflare's own `Authentication-Results` passed a
    DKIM signature of the proved domain, every signature of that domain in the message signs the
    one `To` or `Cc` field, and the address is in it (`signedAddressees`). A sender told to try
    again can come back days later, and its copy keeps its recipient. Mail sent again later, word
    for word, can't make an old message an agent's unless its sender addressed it to the agent,
    which a copy sent again says as truly as the first. Mail through Resend proves no recipient,
    as its API gives no DKIM result, and mail delivered straight to a mailbox here is addressed as
    its `To` and `Cc` say, which this server wrote. One message counts for one agent. The page asks only the mailboxes the agent
    was ever given (`agent_mailbox`, which a trigger fills as grants are made and which keeps them
    after a grant goes, as what it wrote stays there), each through `ofAgent`: what it wrote and
    received by partial indexes on `sent_by` and `came_for`, what waits from `outgoing`'s held
    rows. It keeps the newest 50 of each list, and says which mailbox didn't answer rather than
    failing. A request with a key, the agent's own included, and anyone but an owner or admin get
    the same 404 as for an agent that doesn't exist. While it is open and in sight, it looks again
    every 15 seconds.
  - **An agent's log** (`server/agent-log.ts`, D1 `agent_log`) is on its page, under Activity, and
    at `/api/agents/<workspace>/<agent>/log`, for owners and admins as the page is, a page of 50 at
    a time, of one kind or all. It notes what the agent did with its key: each message it opened
    (`message.read`, by `readMessage` and the raw and HTML routes) or took only a code from
    (`code.read`), each file it took from one (`attachment.read`, by `openAttachment`, for the
    download route and `get_attachment` alike), each search (`mail.searched`, once for its first page and without its words,
    as the index holds what messages say), what it sent or wrote to wait (`outboxAnswer`), with
    what it said that was for, the
    addresses it made and ended, and its webhooks. Those are the routes the MCP tools and the REST API go through, so
    one note covers all three. It notes too what people did to it: making it, renaming it, its
    keys, its policies, pausing and resuming it, its mailboxes (`setMailboxAccess`, by the change
    for each agent), approving or rejecting what it wrote, and an admin's pause, test or deletion
    of its webhook. An entry keeps who did it, the mailbox, the message's id, thread and subject,
    and a few words, such as the address made or what a policy became, never what a message says
    or a webhook URL's path. A subject that gives a sign-in code is kept with it blanked out
    (`withoutCode`). A note is written after what it tells of and can't undo it: when D1
    refuses it, the Worker's log says so, by action. The daily run lets entries go after 90 days,
    and an agent's goes with it.
  - **The agents at a glance** (`server/agents-glance.ts`) head the workspace's home for owners
    and admins, and `/api/agents/<workspace>` gives the same as JSON: each agent, paused or not,
    the addresses it holds, how many messages it sent, held for approval and read (its `reads`
    kind) with its key in the last 24 hours, the last thing it did with it, and when a key of its
    was last used, refused or not (`agent_key.last_used_at`), as an agent waiting for mail or
    paused and trying leaves nothing in its log. They come from D1
    alone, the agents and their log, in two statements whatever their number: the counts by
    `agent_log_agent_idx` from the time on, the last by the same index from its newest end, so
    the home costs no mailbox's object a call. While the home is in sight, it asks for them again
    every 15 seconds, and only for them, keeping an answer only if nothing newer came while it
    was asked for. When they fail, the mailboxes still show. Members, keys and strangers get
    nothing, as for an agent's page.
  - **Addresses an agent makes** (`server/directory/agent-addresses.ts`), such as one for each
    sign-up or task. An owner or admin sets how many it may hold at once, how long each may last
    and on which proved domains (`agent_address_policy`, keyed by membership, set on the Agents
    page with a recent sign-in). Without a policy it makes none. With its key, the agent makes one at
    `/api/mail/<workspace>/<mailbox>/addresses` (`make`), lists those it made there (`GET`) and
    ends one of its own early (`end`). The address goes to a mailbox whose grant lets the agent
    send, never further than its policy says, and always ends: an agent never makes a permanent
    one. It may make in a day as many as it may hold, so it can't end and make addresses in a
    loop. Ended addresses keep their names for 30 days, so the workspace's agents together may
    have made at most half of its 5,000 addresses, ended ones included, and people always have
    room for theirs. One `INSERT … SELECT … WHERE` checks all of it in the statement that adds
    the row: the policy, the grant, the proved domain and every count. Neither calls at once nor
    an admin's change in the meantime can pass it, and only when it adds nothing is the reason
    looked for.
    Without a name of its own, Mail picks 12 random letters and digits. An agent can't take the
    names that prove who runs a domain: a certificate authority writes to `admin`,
    `administrator`, `webmaster`, `hostmaster` and `postmaster` before it issues a certificate
    (CA/Browser Forum Baseline Requirements 3.2.2.4.4). Nor can it take RFC 2142's role names, or
    `root` and `mailer-daemon` (`RESERVED_LOCAL_PARTS`). An admin can still add any of them.
    Nor can it take a name that was removed from an address while it still took mail, or within
    30 days of its end, until 30 days have passed since it stopped taking mail
    (`removed_address`, written by a trigger however the row goes, and cleared by the daily run).
    Whatever wrote to the old address may still, password resets say, and an agent mustn't be the
    one to catch it.
    `mail_address.agent_member_id` names the agent. Triggers stand in for a reference
    (`0016_agent_address_triggers.sql`), as Drizzle Kit's `ADD COLUMN` drops `ON DELETE`:
    - the agent must be an agent of the mailbox's workspace;
    - when its membership goes, however that comes about, its addresses end at once and no longer
      name it;
    - when it may no longer send from a mailbox, its addresses there end at once, since it could
      neither make them now nor see or end them there.

    Lowering its limits, or taking a domain from them, leaves the addresses it has until they
    end.

    Owners and admins see on the workspace's page which agent made each address, and can remove
    it.
  - **The MCP server and the agent API** (`server/mcp/` at `/mcp`, `server/agent-api/` under
    `/api/v1`). An agent reaches with its key what the REST routes give it, as sixteen
    operations: `list_mailboxes`, `search_email`, `read_email`, `get_attachment`, `wait_for_email`,
    `get_verification_code`, `send_email`, `reply`, `list_addresses`, `create_address`,
    `end_address`, and for webhooks of its own `list_webhooks`, `create_webhook`, `update_webhook`,
    `delete_webhook` and `test_webhook`. Each is defined
    once, in `agent-api/operations.ts`: its input and output as zod schemas (the outputs in
    `outputs.ts`), its words, and its REST route. The MCP server makes a tool of each, the API a
    route (`GET /api/v1/mailboxes`, `GET /api/v1/verification-code` and so on), and
    `/api/v1/openapi.json` is written from the same schemas (`z.toJSONSchema`), so a tool, its
    route and the document can't say different things. A route takes its inputs from its path,
    then from its query string for a GET or DELETE, reading numbers and booleans as the input
    has them, or from its JSON body for a POST or PATCH (1 MB at most, however it is sent, or
    16 MB for `send_email` and `reply`, whose files come in it), and
    answers
    what the tool would, checked against the same schema, or `{ "error" }` with 400, 401, 403,
    404, 409, 413 or 429 (with `Retry-After` when known). A failure of Mail's own is a 500 over
    REST and a tool error over MCP, in the same words, and is logged by its kind alone, as what a
    database or a message said may hold mail. Any site may call the API (CORS without
    credentials), as only a key counts and a browser sends none of its own.

    The document is also kept in the repository, as `packages/mail/openapi.json` for
    `https://mail.example.com`, a snapshot that `agent-api/openapi.test.ts` checks. The SDK in
    `packages/mail` (`@gateweave/mail`) is made from that file: `scripts/generate.mjs` turns each
    route into an input type (its path, query and body inputs in one, as its MCP tool takes them),
    an output type and a row of `ROUTES`, and its client makes one method of each row, so it adds
    nothing to the API and can't fall behind it without a test failing. It reaches the API as any
    caller does, with the key as a bearer token, and checks webhook signatures with Web Crypto. The
    `gateweave-mail` command line is made of the same client, for scripts and CI jobs: `code` calls
    the bounded wait again until its own timeout, honouring a 429's `Retry-After`, and reads the
    key and the webhook secret only from the environment.

    Both are stateless (the MCP server is `createMcpHandler` from `@modelcontextprotocol/server`,
    as in Track) and take only an agent's key: without one, or with one that doesn't work, they
    answer 401, whatever cookies come with it. The key only lets the request in. Each operation
    calls the functions the REST routes call (`listMessages` and the rest of `read.ts`,
    `outboxAnswer`, `agentAddressesAnswer`), and they read the same `Authorization` through
    `currentCaller`, so there is no second set of rules to keep in step. A mailbox is named by its
    id, its name or one of its addresses, among those the agent may read; any other is "no
    mailbox", whether it exists or not. The document itself is public.

    A wait (`wait_for_email`, `get_verification_code`) looks at the mailbox at first every
    second, then less often, up to every 5 seconds, for up to 50 seconds, under the 60 that MCP
    clients usually wait, and gives the newest message that came in and matches: to an address
    (`cameTo`, the envelope's recipient, whatever the `To` says), from an address or a domain and
    its subdomains, with words in its subject, proved or not. Mail from the 5 minutes before the
    call counts, as a confirmation may come before the agent asks. Each look asks as the key, so
    revoking it ends the wait. A key may start 30 waits in 10 minutes, over MCP and REST together
    (`allowAgentWait`), so a stuck agent can't keep the Worker looking for it.

    Mail is how a stranger reaches an agent, so whatever an operation hands over from a message comes
    marked as the sender's words, never instructions, beside its proved domain and DMARC verdict.
    `get_verification_code` gives only the code (`lib/verification-code.ts`), the From's domain
    and the proof, never the text around it or the part of the address before the @. It needs the
    sender (`from`), and by default takes only mail whose From's domain is proved, so a stranger
    who writes first with a forged From and a code of their own is passed over. The code is the
    first after a word that names one ("code", "OTP"), or one right beside a word such as
    "verify", in the subject or a line of the text, or one set apart in the lines after, or else
    the only line in the message that is a code alone; null rather than a guess. Its patterns run
    in time linear in the text, as a stranger writes the text.

    How an agent should use all this is a skill, `plugins/gateweave-mail/skills/mail/SKILL.md`,
    plain Markdown any agent can follow, which the Claude Code plugin beside it carries with the
    MCP server. The plugin asks for Mail's MCP address and the key when it is installed, and
    Claude Code keeps the key with its own sign-in (`userConfig`, `sensitive`: the macOS Keychain,
    or its `.credentials.json` elsewhere), never in its settings or the project. The repository's
    `.claude-plugin/marketplace.json` offers the plugin, so
    `claude plugin install gateweave-mail --marketplace gateweavehq/mail` installs it, whichever
    Mail it is for. The plugin has no `version`, so each commit is one and a change to the skill
    reaches whoever runs `claude plugin update`. `agent-api/skill.test.ts` holds the skill to the
    operations: every tool it names exists and every tool is in it, each route it gives is that
    tool's, every field it names is an input or output of some tool, and the numbers it gives
    are the constants'. Change the skill with the operations.
  - **Webhooks** (`server/webhooks/`, ported from Track). A webhook posts each message a
    mailbox receives, and what becomes of mail it sends, to a URL of the workspace's, such as an
    agent's trigger, so that an agent hears of mail without waiting for it. Owners and admins
    manage them on Settings › Webhooks: a URL, its events, and every mailbox or the ones chosen.
    The events are `message.received`; `message.held` (written to wait for approval),
    `message.rejected` and `message.sent` (taken by Email Service or Resend); and, from the
    providers' delivery events, `message.delivered`, `message.bounced` (bounced, failed, or
    rejected by the provider) and `message.complained`, each once per recipient, and none for a
    delay. Changes go
    through `POST /api/webhooks/<workspace>`, which asks where the request is from and that an
    owner or admin asks, and checks that a chosen mailbox is the workspace's. A webhook points
    over https (plain http only where the app itself runs on it), never at Mail's own host, and a
    workspace has at most ten of its own, beside those its agents make.
    - **One object per workspace** (`Webhooks`) holds them, their secrets and the deliveries on
      their way. Nothing but the gateway and the workspace's mailboxes reach it, and secrets never
      leave it but in the answer that makes one, which the page shows once.
    - **From an outbox.** A mailbox's object writes an event (`event`, schema version 8) in the
      transaction that makes the change it tells of, so mail that is kept is always told of and
      mail that isn't, such as a second delivery of the same message, never is. One about mail the
      mailbox sends keeps what it tells of with it (`data`, version 9), taken then: who wrote,
      approved or rejected the message, by membership, whom it went to, its subject and, for a
      recipient's server, that recipient's state. A rejected message is deleted at once, and is
      told of all the same. A recipient's record that only gets newer, or moves from one kind of
      bounce to another, tells of nothing, and as a record never moves back, a delivery reported
      after a complaint is not told either. A mailbox that has sent mail but neither sent nor
      received any since it began keeping its `place` takes its mailbox from its own name
      (`ctx.id.name`) and its workspace from that mail. Its alarm, a second later, hands the events to
      the workspace's object and drops them once it has them, or tries again a minute later. That
      object queues one delivery for each webhook that listens, once per event however often it
      is handed over, and sends them from its own alarm: ten at a time, ten seconds each, claiming
      them first so that a restart retries them. A receiver that answers anything but a 2xx, a
      redirect too, is tried again after 5 seconds, 5 minutes, 30 minutes, 2, 5 and 10 hours.
      Deliveries are kept seven days, for the page to show each webhook's latest. No Queue or
      other binding is needed.
    - **Signed per [Standard Webhooks](https://www.standardwebhooks.com)**, as Track's are:
      `webhook-id` (the delivery's id, the same on every retry), `webhook-timestamp`, and
      `webhook-signature`, `v1,` and an HMAC-SHA256 of `id.timestamp.body` keyed by the `whsec_`
      secret. Making a new secret signs what is sent from then on, retries too.
    - **Bodies are `{ type, timestamp, data }`.** `message.received` carries the workspace (id and
      slug, looked up when the event is queued), the mailbox (id and name) and the message as the
      agent API's summaries have it: ids, when it arrived, who it is from, its subject and Date,
      the address it came to, the proved domain, the DMARC verdict, its size and where people open
      its thread. Never its text: the receiver reads that with an agent's key, under that agent's
      access. The sender's words come marked as such (`untrusted`), as over the agent API.
      The events about mail the workspace sends carry the workspace, the mailbox, the message
      (ids, when it was written, its From, To, Cc and subject, who wrote and who approved it, what
      its writer said it was for, and where people open its thread), `by`, who did what the event tells of (for `message.sent`,
      who sent it again, or else who approved it, or else who wrote it), and `recipient`, for
      a recipient's server: the address, its state, when, and what the server said. Members are
      named as the workspace has them when the event is queued, with whether they are an agent,
      and by id alone once they have left. Those bodies are marked untrusted too, since a reply
      keeps the subject of the mail it answers and a server's answer is that server's.
      `webhook.test`, sent when an admin asks, one at a time, carries the workspace and the
      webhook's id.
    - **Pausing** a webhook drops what it hadn't delivered; deleting it drops that too. Taking a
      mailbox or an event off it drops what was waiting for those, and a new URL gets the rest. A
      deleted workspace's object is cleared with it, and clears itself should it find the workspace
      gone. When D1 doesn't answer its alarm, the alarm sets itself a minute on rather than throw,
      since Cloudflare stops retrying one that keeps throwing.
    - **An agent's own** (`webhook.agent_member_id` and `agent_key_id`, the object's schema
      version 2). An agent makes up to three with its key, through the agent API, so that it hears
      of mail without an admin setting a webhook up for it. They point over https only, and an
      agent's request never changes the app origin the object keeps, which only an admin's sets
      once it is known. They hear of every mailbox it may read, or those it names among them, and
      only while it may: as each event is queued, the object asks D1 whether the key that made the
      webhook still works and the agent may read the mailbox (`canReadMailbox`, as its routes do),
      and asks again before attempts, at most ten seconds apart, so a retry about a mailbox taken
      from it, or after the key went, is dropped. Of mail it writes, they aren't told what it did
      itself (`by` is the agent: holding mail, or sending what needed no approval), only what
      people and servers did, and members come by id and whether they are an agent, never by name,
      as the agent API gives no member's name. Revoking the key, or deleting the agent, removes
      them, as does the object, or the webhooks page before it lists them, on finding the key
      gone. Owners and admins see them on Settings › Webhooks, named by their agent, and may pause,
      resume, test or delete them, but not change where they go or what they hear, nor make them a
      new secret, which the agent couldn't learn. An admin's pause holds: the agent sees
      `pausedByAdmin` and can't resume it. An agent sees only its own, and their deliveries.
    - **Its own zone.** The Worker runs with `global_fetch_strictly_public`, so a webhook to a host
      on Mail's own zone goes in through Cloudflare, past that host's security settings and to
      whatever Worker serves it, as anyone's request would, never straight to the origin.
  - **HTML.** A message's HTML is a page of its own, at `…/<message>/html`, which the message's
    page shows in a frame; its text, or the text made from its HTML, is a click away. What makes
    it safe is the policy it is served with (`framePolicy` in `html.ts`): `sandbox` without
    `allow-scripts` or `allow-same-origin`, so nothing runs and the page has an opaque origin
    that can't read the app's cookies or reach its pages, even when opened on its own;
    `default-src 'none'`, so it loads nothing from elsewhere; and links that may only open a
    tab of their own. An opaque origin gives what a second hostname would, without every
    deployment having to set one up. Remote images load only when the reader asks, since
    loading them tells the sender the message was opened: for that view, or by themselves for
    a sender the reader allowed (below). HTMLRewriter cleans the
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
  - **Images a reader allows** (`mailbox/image-senders.ts`, `server/images.ts`). A reader can let a
    sender's remote images show by themselves, by the domain a message was proved to come from
    (`verifiedDomain`) and by nothing else: anyone can write a `From`. The choice is the member's
    own (D1 `image_sender`), as each reader of a shared mailbox decides for themselves whether
    senders learn they opened something, and it goes with their membership. A message's JSON says
    `imagesAllowed` when it has remote images and its proved domain is on the reader's list; an
    agent's key never has one. To allow, the page names a message, not a domain, and the server
    reads the domain from the message as it was judged on arrival, so a domain that proved nothing
    can't be added. The page says when images showed because of the choice, with a button to take it
    back, and a choice reaches every message from that domain already open, a thread's older ones
    too. Settings › Images lists them. At most 500 per person in each workspace, counted as the row
    is written.
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
    Email Sending. It goes to at most 20 people, To and Cc together, with a
    subject that has no line break. A workspace sends at most 200 messages a day (`SEND_PER_DAY`),
    counted by the rate-limit object, besides Email Service's own limits.
    - **Its copy is in the mailbox before it goes.** The object takes the message as Mail wrote it,
      as an RFC 5322 copy for R2 named pending first as arriving mail is, with an `outgoing` row,
      in one transaction, and only then calls the binding. So the copy is in its thread at once,
      says who wrote it (`message.sent_by`, a membership), and counts toward the mailbox's size; a
      full mailbox doesn't send.
    - **What it was written for** (`context`, schema version 15): its writer may give one https
      link, such as the CI run, issue or pull request behind it, and a label of up to 100
      characters, as `context` of `send_email` and `reply` or of the outbox's `send`. `sentContext`
      (`lib/outbox.ts`) takes only https, without a user name or password, writes the link as the
      URL parser does (a host in another script as its punycode) and takes control and format
      characters out of the label, so it can't turn text around. It is kept in `message.context`,
      shown beside the message ("Its writer said it is for …", with the link's host beside its
      label), in the rows of the agent's page and its log (`agent_log.context`), and carried by
      each webhook event about the message, always as the writer's words, as Mail checks nothing
      else about it. It is never put in the mail.
    - **HTML and files go in the copy, and from it** (`files.ts`). A message carries text, and
      HTML and files when its writer gives them.
      - **The composer writes text, and HTML from it.** What a person types is the text, and
        bold, italic, links, lists and quotes are its marks (`formatting.ts`), the ones mail used
        before Markdown took them up. When the text uses any, HTML made from it goes beside it.
        Mail reads those marks itself, in one pass over each line, rather than with a Markdown
        library: no HTML, headings, code, tables or images in the text are read, links go to the
        web and mail only, and nothing a person types can make the reading slow. Lines are kept as
        typed, their spaces, backslashes and entities too: one that only looks like a heading or a
        rule, "9. November" or a number that doesn't follow on, a line after a list, and a link it
        can't make or whose words name another place, even a host Mail doesn't know, all stay as
        they were written. A link's words are read as a browser reads a host, with what stands
        against them (a fullwidth dot is a dot, an invisible character nothing, and
        `[bank](…)[.example](…)` shows bank.example), and its address is written as a browser
        reads it, never with a name before its host or mail to people its words don't name. A
        quote is someone else's words, as a reply's is, so nothing in it is
        read as a mark, or its links could go under the workspace's name to places their words
        don't say; the sender's name above it loses its brackets for the same reason. The toolbar
        types the marks into the text, so each change can be undone, and the
        preview shows the HTML that will go, its links opening in a tab of their own. Files are
        attached, dropped or pasted (a file only, as a copied document holds a picture of itself
        beside its text), and checked against the limits below as they are added.
      - **What a person approves is what goes.** The HTML is kept to what the message's page shows
        of mail (`sendableHtml` in `html.ts`, the rules `cleanHtml` uses): no scripts, forms, SVG,
        media or frames, and nothing of what they hold. Text is made from the HTML when none is
        written, and a message with neither isn't sent. An agent gives text or HTML, never both,
        as text written beside the HTML could say what the page doesn't show.
      - **Files.** At most 20, 10 MB together, in Base64. A file's type comes from its name when
        none is given. Only a PNG, JPEG, GIF or WebP image goes inline, by the content id its
        `cid:` names, and only beside HTML: an inline text part would be read as the message's own
        text. A name has at most 200 characters and no path, control character, mark that turns
        its text around, or `=?`, which mail reads as encoded text. The kinds of file Resend refuses
        (`.exe`, `.js`, `.bat`, `.msi` and the rest of `REFUSED_KINDS`) are refused for both
        providers, as many mail servers refuse them too. All of this is decided when the message is
        written, before anything counts.
      - **Each try reads the files from the copy.** The copy in R2 is the whole message in MIME
        (`multipart/alternative` for the HTML, `related` for the images it shows, `mixed` for
        files). The object keeps the text and HTML in its request, and a list of the files with
        their names, types, content ids and sizes (`outgoing.files`). A try takes each file's bytes
        from the copy and the rest from that list, so nothing reading the copy does to a name
        reaches the providers, and it sends nothing when the copy doesn't hold those files, one for
        one and byte for byte: the message is refused (`mail:copy_unread`), or `uncertain` after a
        try that may have gone. R2 failing is tried again as a busy moment is. A calendar is kept as
        `application/octet-stream` in the copy, as a reader would decode it as text and change its
        line ends, and goes as `text/calendar`. Email Service is handed each file's bytes and
        Resend its Base64, as each takes them.
      - **Sizes.** Base64 makes 10 MB about 13.4, so the API takes a body of 16 MB to send
        (`MAX_SEND_BODY`), and so does the MCP handler, for every tool, as it reads a request
        before it knows which tool it calls. The agents' API hands the message to the outbox as
        it read it, rather than writing it out to be read again.
    - **Its own id keeps the thread.** Email Service makes the `Message-ID` and refuses one from
      the sender, and nothing says the id it returns is the header's. So Mail gives each message an
      id of its own, `<uuid.signature@domain>`, puts it last in `References`, and keeps it as the
      copy's own: a reply to the message names it, and joins the thread, whatever id the message
      went out with. The signature (`own-id.ts`) is an HMAC of the mailbox, the uuid and the
      domain, cut to 128 bits, under a key HKDF derives from `BETTER_AUTH_SECRET`, so `isOwnId`
      tells an id Mail gave the mailbox from one a sender made up, without looking anything up.
      It proves where the id came from, not who answers with it: anyone the message reached can
      name it, so whatever acts on a reply to the mailbox's mail also asks who sent the reply.
      Threading never asks: it matches ids as they are, so ids from before they were signed, or from
      before the secret changed, keep their threads. A reply takes `In-Reply-To` and `References`
      from the answered message's own headers: its `References`, or failing those its `In-Reply-To`,
      then its id. A long chain keeps the first id and the newest that fit in Email Service's 2,048
      bytes for a header.
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
      can be added. The sealed value names the key it was sealed with (`v2.<key id>.…`; one from
      before ids, `v1.…`, opens with either key), and after `SECRETS_KEY` changes, the daily run
      seals each workspace secret in D1 again under the new one (`reseal-secrets.ts`: Resend keys
      and inbound webhooks' signing secrets, up to 500 a run, read in pages so that values which
      don't open never hold up the rest, each written only if it is still the value that was
      read), logging `secrets:` with what it resealed, what neither key opened, and
      what is left under another key. A domain can be set to Resend only while the workspace has a key, and a message
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
      so each try notes which saving of the workspace's key it used (`outgoing.key_version`: the
      row's `version`, new each time a key is put in, or a digest of the sealed value for one put
      in before versions were kept; `keyVersion`), which sealing it again leaves as it was. The
      column keeps it with the saving's `added_at`, so a key put in by code that doesn't know the
      column, as after a rollback, isn't taken for the one before. After a try that may have gone,
      a different one stops it as `uncertain` (`resend:key_changed`). Someone who then sends it again takes the new key.
    - **Straight to a mailbox here** (`mailbox/direct.ts`). A message whose every recipient, To
      and Cc, is a live address of this deployment, in any workspace, isn't handed to a provider:
      the sending mailbox's object reads its copy from R2 and stores it in each recipient's
      mailbox through `storeMail`, the path `email()` takes, so it is kept once, threaded, counted
      against that mailbox's space, told to webhooks (`message.received`) and indexed, and comes
      for the agent that made the address. Out through Email Service and back through MX it would
      cost a send and a place in the provider's limits, take seconds and be scored for spam. A message that also goes elsewhere goes through its provider to everyone, as
      before: Email Service and Resend take one list for the headers and the envelope, so leaving
      our own addresses out would take them out of what the others see. Which way is decided at
      the first try and kept (`outgoing.direct`), so a later try never hands to a provider what a
      mailbox here has; one that may have gone through Resend stays with Resend. The recipients'
      copies have no DMARC result: their `verified_domain` is the sender's domain, which the
      directory proved, because the sender is still an address of the sending mailbox on that
      domain, as each try checks again (`mail:direct_sender` refuses it when it isn't). A proof in
      the directory outlives its TXT record, so it says who held a domain once; DNS decides who
      holds it now, and mail through a provider meets DNS as it is. So the first try also asks
      DNS (`heldToday`, a minute's cache): every domain involved must still show its holder's
      proof record, and each recipient's MX must take its mail the way it reaches Mail here.
      When it doesn't, or DNS can't say, the message goes through its provider. Each
      recipient's record says `delivered` as soon as it is stored, and an address that is gone
      by then `bounced`. A mailbox that is full, or a store that failed, waits on the busy waits
      (`mail:direct_full`, `mail:direct_unavailable`); a mailbox keeps a message once, so trying
      again gives no one a second copy, and the alarm tries a stale `sending` one again too.
      When the waits run out, those still without it are `bounced` and the message is `sent`. A
      message some recipients have can't be discarded; deleting it records it as `sent`, and the
      others as `failed`. A try writes its decision and its outcome only while the row is still
      its own (`attempted_at`), so one the alarm gave up on changes nothing when it ends. The
      gateway's checks stay as they are: the suppression list, the workspace's day and an agent's
      policy and approval. A mailbox may send to its own address, and keeps the copy and the mail
      it got side by side in the thread. `DIRECT_DELIVERY=off` sends everything through the
      provider, to test the real path (`test/direct-delivery.test.ts`).
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

## Not built yet

This is where it is going, and it may change. What is above stays as it is: one Worker for the UI,
the API, auth and `email()`, with D1 for accounts and the address directory, a Durable Object per
mailbox and R2 for raw mail.

- **Aliases that point at a mailbox.**
- **Images in the composer's HTML**, as agents send them already, forwarding, and replying to
  all.
- **Transactional sending and templates**, through Cloudflare Email Service.

## What Cloudflare does with mail

Measured on 2026-11-07. These shape the design above, and Cloudflare may change them.

- **A zone has one catch-all rule,** and it also catches mail for subdomains that have Email
  Routing enabled.
- **A zone can have 200 literal routing rules,** across the whole zone, not per Worker.
- **A new literal rule takes from about half a minute to over a minute to work.** An address
  cannot be handed out and used in the same moment through rules, which is why the catch-all and
  our own directory decide, not a rule per address.
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
- **Cloudflare's `Authentication-Results` lists a result for each DKIM signature first,** with its
  domain, selector and the start of its signature (`dkim=pass header.d=… header.s=… header.b=…`),
  then `dmarc=`, then `spf=` results that quote the envelope sender and the HELO name, which the
  sender chooses, then `arc=`.
- **`message.headers.get()` joins a repeated header with ", "**, so it can't tell Cloudflare's
  `Authentication-Results` from a sender's. Mail reads the header block from the raw message
  instead.

Sending through Email Service's Workers binding, measured on 2026-11-09:

- **A file's `content` given as a string goes as those characters,** not as the Base64 they spell,
  although the binding's type says "Base64 string or binary content". The recipient gets the
  Base64 text as the file. Mail hands it bytes, and the stand-in binding in `test/mail-worker.ts`
  does the same as the real one, so a string there fails the tests.
- **It writes the message again:** parts arrive quoted-printable or 7bit, whatever they were
  given as, and an inline image arrives without its filename.
- **It took every kind of file tried,** among them `.html`, `.zip`, `.svg`, `.json`, `.docx` and
  `.eml`. Mail refuses Resend's refused kinds for both providers all the same.
