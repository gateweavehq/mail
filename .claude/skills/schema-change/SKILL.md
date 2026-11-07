---

name: schema-change
description: Change the D1 database schema in Gateweave Mail with a proper migration - users, sessions, workspaces, members and invitations (via Better Auth), and the owner triggers. Use when adding or altering tables, columns, indexes or triggers.
---

# Change a schema

Mail has one database today, D1. Its tables are Better Auth's: users, sessions, accounts,
verifications, workspaces (organizations), members and invitations. The schema is generated from
the Better Auth configuration, so don't edit `apps/web/src/server/db/auth-schema.ts` by hand.

Migrations are append-only. Never edit or delete a migration that has been merged; write a new
one that moves the schema forward. When another branch's migration lands first, regenerate yours
after it rather than renaming it.

Tables for mail (mailboxes, the address directory) will be added here as ordinary Drizzle
tables, in `apps/web/src/server/db/`, and exported from `schema.ts`.

## Steps

1. Change the Better Auth configuration (`apps/web/src/server/auth/config.ts`), for example a
   plugin or `additionalFields`, or add a table file under `apps/web/src/server/db/`.
2. Regenerate the Drizzle schema for Better Auth's tables, then the migration:

   ```sh
   pnpm --filter @gateweave/mail-web auth:schema
   pnpm --filter @gateweave/mail-web db:generate
   ```

   Drizzle Kit also runs directly, from `apps/web`:
   `node node_modules/drizzle-kit/bin.cjs generate`.
3. For what Drizzle cannot express, such as a trigger, make a custom migration and write the SQL
   in it: `drizzle-kit generate --custom --name what_it_does`. `0001_owner_triggers.sql` is one.
4. Read the SQL in `apps/web/migrations/`, then apply it locally and run the app:

   ```sh
   pnpm --filter @gateweave/mail-web db:migrate:local
   ```

5. Deploys apply D1 migrations before the new code goes live (`apps/web/scripts/deploy.mjs`), for
   Gateweave's staging and self-hosters alike. Old code still runs against the new schema until
   the deploy finishes, so say in the pull request whether it can.

`drizzle-orm` stays on 0.45: the 1.0 migration format does not work with Wrangler's D1
migrations.

## Verify

```sh
pnpm verify
```

The Worker tests apply every migration in `apps/web/migrations/` to a fresh database, so one
that fails on an empty schema fails there.
