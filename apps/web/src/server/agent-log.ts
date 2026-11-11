import { and, desc, eq, inArray, lt, or } from "drizzle-orm";
import {
	AGENT_LOG_KINDS,
	AGENT_LOG_PAGE,
	type AgentLogAction,
	type AgentLogEntry,
	type AgentLogKind,
	type AgentLogPage,
	MAX_LOGGED_DETAIL,
	MAX_LOGGED_SUBJECT,
} from "../lib/agent-log";
import { keptContext, type SentContext } from "../lib/outbox";
import { withoutCode } from "../lib/verification-code";
import { type Database, schema } from "./db";

// An agent's log: what it did with its key, and what people did to it. It takes the database as
// an argument, as the agents plugin, which Better Auth's setup imports, writes to it too.

/** What happened to or by one agent, as the code that did it says. */
export interface AgentLogNote {
	workspaceId: string;
	/** The agent's membership. */
	agentMemberId: string;
	/** The agent itself, with its key, or a person, by user id. */
	by: "agent" | { userId: string };
	action: AgentLogAction;
	mailboxId?: string | null;
	/** A message, an address, a webhook or a key, by id. */
	targetId?: string | null;
	threadId?: string | null;
	/** A message's subject, as people read it, never more of it. */
	subject?: string | null;
	detail?: string | null;
	/** For mail the agent wrote, what it said the mail was for, as `sentContext` made it. */
	context?: SentContext | null;
}

// An empty subject stays one, so the page says "(no subject)" and opens its thread.
const cut = (value: string | null | undefined, most: number) =>
	value == null ? null : value.slice(0, most);

/**
 * Writes entries to agents' logs, each with the time it is written. A log that can't be written
 * doesn't undo what it tells of, which has happened by then: the Worker's logs say so, by kind.
 */
export async function noteAgent(
	db: Database,
	...notes: [AgentLogNote, ...AgentLogNote[]]
): Promise<void> {
	const at = new Date();
	const rows = notes.map((note, index) => ({
		// The page lists by time, then by id: entries written together keep their order.
		id: `${String(index).padStart(3, "0")}-${crypto.randomUUID()}`,
		organizationId: note.workspaceId,
		agentMemberId: note.agentMemberId,
		byAgent: note.by === "agent",
		actorUserId: note.by === "agent" ? null : note.by.userId,
		action: note.action,
		mailboxId: note.mailboxId ?? null,
		targetId: note.targetId ?? null,
		threadId: note.threadId ?? null,
		// Subjects often carry a sign-in code, which the log never keeps.
		subject: cut(note.subject == null ? null : withoutCode(note.subject), MAX_LOGGED_SUBJECT),
		detail: cut(note.detail, MAX_LOGGED_DETAIL),
		context: note.context ? JSON.stringify(note.context) : null,
		at,
	}));
	try {
		// One statement each, as D1 binds at most 100 values to one.
		const [first, ...rest] = rows.map((row) => db.insert(schema.agentLog).values(row));
		if (first) await db.batch([first, ...rest]);
	} catch (error) {
		console.error("agent log: an entry couldn't be written", {
			actions: [...new Set(notes.map((note) => note.action))],
			name: error instanceof Error ? error.name : "unknown",
		});
	}
}

/** Drops an agent's log, as its agent goes. */
export async function dropAgentLog(db: Database, workspaceId: string, agentMemberId: string) {
	const { agentLog } = schema;
	await db
		.delete(agentLog)
		.where(and(eq(agentLog.organizationId, workspaceId), eq(agentLog.agentMemberId, agentMemberId)))
		.run();
}

/**
 * A page of one agent's log, newest first, of one kind or all, before a cursor when given. The
 * caller has checked that whoever asks may see it.
 */
export async function agentLogPage(
	db: Database,
	workspaceId: string,
	agentMemberId: string,
	kind: AgentLogKind | null,
	before: { at: number; id: string } | null,
): Promise<AgentLogPage> {
	const { agentLog, mailbox, user } = schema;
	const rows = await db
		.select({
			id: agentLog.id,
			at: agentLog.at,
			action: agentLog.action,
			byAgent: agentLog.byAgent,
			actorName: user.name,
			mailboxId: agentLog.mailboxId,
			mailboxName: mailbox.name,
			targetId: agentLog.targetId,
			threadId: agentLog.threadId,
			subject: agentLog.subject,
			detail: agentLog.detail,
			context: agentLog.context,
		})
		.from(agentLog)
		.leftJoin(user, eq(user.id, agentLog.actorUserId))
		// Only a mailbox of this workspace is named.
		.leftJoin(
			mailbox,
			and(eq(mailbox.id, agentLog.mailboxId), eq(mailbox.organizationId, workspaceId)),
		)
		.where(
			and(
				eq(agentLog.organizationId, workspaceId),
				eq(agentLog.agentMemberId, agentMemberId),
				kind ? inArray(agentLog.action, [...AGENT_LOG_KINDS[kind]]) : undefined,
				before
					? or(
							lt(agentLog.at, new Date(before.at)),
							and(eq(agentLog.at, new Date(before.at)), lt(agentLog.id, before.id)),
						)
					: undefined,
			),
		)
		.orderBy(desc(agentLog.at), desc(agentLog.id))
		.limit(AGENT_LOG_PAGE + 1)
		.all();
	const shown = rows.slice(0, AGENT_LOG_PAGE);
	const last = shown.at(-1);
	return {
		entries: shown.map(
			(row): AgentLogEntry => ({
				id: row.id,
				at: row.at.getTime(),
				action: row.action as AgentLogAction,
				by: row.byAgent ? { agent: true } : { agent: false, name: row.actorName },
				mailbox: row.mailboxId ? { id: row.mailboxId, name: row.mailboxName } : null,
				target: row.targetId,
				subject: row.subject,
				detail: row.detail,
				context: keptContext(row.context),
				thread: row.threadId,
			}),
		),
		next: rows.length > AGENT_LOG_PAGE && last ? { at: last.at.getTime(), id: last.id } : null,
	};
}
