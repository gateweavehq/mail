import { WorkerEntrypoint } from "cloudflare:workers";
import { asc, eq, gt, inArray } from "drizzle-orm";
import { z } from "zod";
import type { BackupRow } from "./backup-read";
import { createDb, schema } from "./db";
import { mailboxStub } from "./mailbox/store";
import { webhooksStub } from "./webhooks";

/** How many workspaces a page of `objects` covers: each is its webhooks and its mailboxes. */
const PAGE = 20;

/** A workspace's or a mailbox's id, as a backup's file name can hold it. */
const PART = /^[A-Za-z0-9_-]{1,64}$/;

const cursorOf = z.string().regex(PART);

/** Which object a backup's name is: `mailbox.<mailbox id>` or `webhooks.<workspace id>`. */
function objectOf(name: unknown): { kind: "mailbox" | "webhooks"; id: string } | null {
	if (typeof name !== "string") return null;
	const parts = name.split(".");
	const [kind, id] = parts;
	if (parts.length !== 2 || id === undefined || !PART.test(id)) return null;
	return kind === "mailbox" || kind === "webhooks" ? { kind, id } : null;
}

/**
 * Gateweave Backup's way in (docs/architecture.md, "Backups"). It lists each workspace's webhooks
 * and mailboxes, then reads one's Durable Object with the SELECTs of a SQLite dump, which the object
 * runs together and rolls back. A named entrypoint has no route: only a Worker in the same account
 * with a service binding to it can call it, so that binding is the access, the way the gateways'
 * checks are for people and agents. Only what D1 still lists is read, so a backup never wakes a
 * removed mailbox's object nor a deleted workspace's; anything else answers null. The rate limiter
 * is left out: it holds counters that expire.
 */
export class Backup extends WorkerEntrypoint<Cloudflare.Env> {
	/**
	 * The objects' names, a page of workspaces at a time: each one's `webhooks.<workspace>`, then
	 * `mailbox.<id>` for each of its mailboxes. Pass back `cursor` for the next page.
	 */
	async objects(cursor?: string): Promise<{ names: string[]; cursor?: string }> {
		const after = cursor === undefined ? undefined : cursorOf.parse(cursor);
		const db = createDb(this.env.DB);
		const rows = await db
			.select({ id: schema.organization.id })
			.from(schema.organization)
			.where(after === undefined ? undefined : gt(schema.organization.id, after))
			.orderBy(asc(schema.organization.id))
			.limit(PAGE + 1);
		const ids = rows.slice(0, PAGE).map((row) => row.id);
		const boxes =
			ids.length === 0
				? []
				: await db
						.select({ id: schema.mailbox.id, workspaceId: schema.mailbox.organizationId })
						.from(schema.mailbox)
						.where(inArray(schema.mailbox.organizationId, ids))
						.orderBy(asc(schema.mailbox.id));
		const names: string[] = [];
		for (const id of ids) {
			names.push(`webhooks.${id}`);
			for (const box of boxes) if (box.workspaceId === id) names.push(`mailbox.${box.id}`);
		}
		const last = ids[ids.length - 1];
		return rows.length > PAGE && last ? { names, cursor: last } : { names };
	}

	/** Runs a backup's reads in one of the objects, or answers null if there is no such object. */
	async read(name: string, statements: string[]): Promise<BackupRow[][] | null> {
		const object = objectOf(name);
		if (!object) return null;
		const db = createDb(this.env.DB);
		if (object.kind === "mailbox") {
			// A removed mailbox's row is gone at once, though its object may wait to be emptied.
			const found = await db
				.select({ id: schema.mailbox.id })
				.from(schema.mailbox)
				.where(eq(schema.mailbox.id, object.id))
				.get();
			return found ? mailboxStub(found.id).backupRead(statements) : null;
		}
		const found = await db
			.select({ id: schema.organization.id })
			.from(schema.organization)
			.where(eq(schema.organization.id, object.id))
			.get();
		return found ? webhooksStub(found.id).backupRead(statements) : null;
	}
}
