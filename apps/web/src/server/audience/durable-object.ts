import { DurableObject } from "cloudflare:workers";
import {
	MAX_TEMPLATES,
	nameKey,
	type Template,
	type TemplateVersion,
	templateInput,
} from "../../lib/templates";
import { type BackupRow, readForBackup } from "../backup-read";
import { migrate } from "./schema";

export type Refused = { ok: false; status: 400 | 404 | 409; error: string };

const refused = (status: Refused["status"], error: string): Refused => ({
	ok: false,
	status,
	error,
});

// Types, not interfaces, so that SQLite's rows can be read as them.
type TemplateRow = {
	id: string;
	name: string;
	createdAt: number;
	updatedAt: number;
};

type VersionRow = {
	number: number;
	subject: string;
	body: string;
	variables: string;
	madeBy: string | null;
	madeAt: number;
};

const TEMPLATE_COLUMNS = "id, name, created_at AS createdAt, updated_at AS updatedAt";
const VERSION_COLUMNS = "number, subject, body, variables, made_by AS madeBy, made_at AS madeAt";

const toVersion = (row: VersionRow): TemplateVersion => ({
	number: row.number,
	subject: row.subject,
	body: row.body,
	variables: JSON.parse(row.variables) as string[],
	madeBy: row.madeBy,
	madeAt: row.madeAt,
});

/**
 * A workspace's audience: what it keeps to write mail with, apart from its mailboxes. For now that
 * is its templates, each a name and its versions (docs/architecture.md, "Templates"). Only the
 * Worker reaches it: the gateway, after checking that a member of the workspace asks, and that an
 * owner or admin does for a change; and the agent API, with an agent's key, to read.
 *
 * Handlers are synchronous and write inside one transaction, so a change is all or none, and two
 * at once can't both take the last place or the same name.
 */
export class Audience extends DurableObject<Cloudflare.Env> {
	constructor(ctx: DurableObjectState, env: Cloudflare.Env) {
		super(ctx, env);
		migrate(ctx.storage);
	}

	/** Reads for Gateweave Backup, run together and rolled back (`../backup-read.ts`). */
	backupRead(statements: unknown): BackupRow[][] {
		return readForBackup(this.ctx.storage, statements);
	}

	/** The live templates by name, each as its latest version is. */
	list(): Template[] {
		const rows = this.ctx.storage.sql
			.exec<TemplateRow>(
				`SELECT ${TEMPLATE_COLUMNS} FROM template WHERE removed_at IS NULL ORDER BY name_key, id`,
			)
			.toArray();
		return rows.flatMap((row) => {
			const version = this.#version(row.id, null);
			return version ? [{ ...row, ...version }] : [];
		});
	}

	/** A live template's versions, newest first; null when there is none with this id. */
	versions(id: string): TemplateVersion[] | null {
		const sql = this.ctx.storage.sql;
		const there = sql.exec("SELECT 1 FROM template WHERE id = ? AND removed_at IS NULL", id);
		if (there.toArray().length === 0) return null;
		return sql
			.exec<VersionRow>(
				`SELECT ${VERSION_COLUMNS} FROM template_version WHERE template_id = ? ORDER BY number DESC`,
				id,
			)
			.toArray()
			.map(toVersion);
	}

	/**
	 * A live template by its name, in any case, as the version numbered says, or its latest: for
	 * sending. `latest` is the number of its latest. Null when there is no such template or version.
	 */
	find(name: string, number: number | null): { template: Template; latest: number } | null {
		const row = this.ctx.storage.sql
			.exec<TemplateRow>(
				`SELECT ${TEMPLATE_COLUMNS} FROM template WHERE name_key = ? AND removed_at IS NULL`,
				nameKey(name),
			)
			.toArray()[0];
		if (!row) return null;
		const version = this.#version(row.id, number);
		if (!version) return null;
		const latest = number === null ? version : this.#version(row.id, null);
		return { template: { ...row, ...version }, latest: latest?.number ?? version.number };
	}

	/**
	 * Makes a template, or with its `id` saves a new version of one, which may rename it. The input
	 * is read here, whoever sends it: its variables, and that it renders. A name may be used once
	 * among live templates, in any case, and a workspace has `MAX_TEMPLATES` of them.
	 */
	save(
		id: string | null,
		input: unknown,
		madeBy: string | null,
	): { ok: true; template: Template } | Refused {
		const parsed = templateInput.safeParse(input);
		if (!parsed.success) {
			return refused(400, parsed.error.issues[0]?.message ?? "That isn't a template.");
		}
		const { name, subject, body, variables } = parsed.data;
		const sql = this.ctx.storage.sql;
		const now = Date.now();
		const key = nameKey(name);
		return this.ctx.storage.transactionSync(() => {
			const taken = sql
				.exec<{ id: string; name: string }>(
					"SELECT id, name FROM template WHERE name_key = ? AND removed_at IS NULL",
					key,
				)
				.toArray()[0];
			let at = id;
			if (at === null) {
				if (taken) return refused(409, `A template called "${taken.name}" exists.`);
				const { n } = sql
					.exec<{ n: number }>("SELECT count(*) AS n FROM template WHERE removed_at IS NULL")
					.one();
				if (n >= MAX_TEMPLATES) {
					return refused(409, `A workspace can have at most ${MAX_TEMPLATES} templates.`);
				}
				at = crypto.randomUUID();
				sql.exec(
					"INSERT INTO template (id, name, name_key, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
					at,
					name,
					key,
					now,
					now,
				);
			} else {
				const live = sql.exec("SELECT 1 FROM template WHERE id = ? AND removed_at IS NULL", at);
				if (live.toArray().length === 0) return refused(404, "No such template.");
				if (taken && taken.id !== at) {
					return refused(409, `A template called "${taken.name}" exists.`);
				}
				sql.exec(
					"UPDATE template SET name = ?, name_key = ?, updated_at = ? WHERE id = ?",
					name,
					key,
					now,
					at,
				);
			}
			const { next } = sql
				.exec<{ next: number }>(
					"SELECT coalesce(max(number), 0) + 1 AS next FROM template_version WHERE template_id = ?",
					at,
				)
				.one();
			sql.exec(
				"INSERT INTO template_version (template_id, number, subject, body, variables, made_by, made_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
				at,
				next,
				subject,
				body,
				JSON.stringify(variables),
				madeBy,
				now,
			);
			const made = sql
				.exec<TemplateRow>(`SELECT ${TEMPLATE_COLUMNS} FROM template WHERE id = ?`, at)
				.one();
			const version = this.#version(at, null);
			if (!version) throw new Error("The version just saved isn't there");
			return { ok: true as const, template: { ...made, ...version } };
		});
	}

	/**
	 * Removes a template: soft, so its versions stay and its name may be used again. What was sent
	 * with it is in the mailboxes, whole.
	 */
	remove(id: string): { ok: true } | Refused {
		const now = Date.now();
		const done = this.ctx.storage.sql.exec(
			"UPDATE template SET removed_at = ?, updated_at = ? WHERE id = ? AND removed_at IS NULL",
			now,
			now,
			id,
		);
		return done.rowsWritten === 0 ? refused(404, "No such template.") : { ok: true as const };
	}

	/** Removes everything, as when the workspace is deleted. */
	async destroy(): Promise<void> {
		await this.ctx.storage.deleteAll();
		// Empty again, for anything still on its way to this object.
		migrate(this.ctx.storage);
	}

	/** A template's latest version, or the one numbered. */
	#version(id: string, number: number | null): TemplateVersion | null {
		const sql = this.ctx.storage.sql;
		const row =
			number === null
				? sql
						.exec<VersionRow>(
							`SELECT ${VERSION_COLUMNS} FROM template_version WHERE template_id = ? ORDER BY number DESC LIMIT 1`,
							id,
						)
						.toArray()[0]
				: sql
						.exec<VersionRow>(
							`SELECT ${VERSION_COLUMNS} FROM template_version WHERE template_id = ? AND number = ?`,
							id,
							number,
						)
						.toArray()[0];
		return row ? toVersion(row) : null;
	}
}
