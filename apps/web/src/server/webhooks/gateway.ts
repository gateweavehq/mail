import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { isAdminRole } from "../../lib/roles";
import {
	type WebhookAnswer,
	type WorkspaceWebhooks,
	webhookInput,
	webhookPatch,
} from "../../lib/webhooks";
import { currentMember } from "../access";
import { noteAgent } from "../agent-log";
import { db } from "../auth";
import { schema } from "../db";
import { appOrigin } from "../origin";
import type { Asker, Refused, WebhookLink } from "./durable-object";
import { webhooksStub } from "./index";

const ADMIN: Asker = { admin: true };

const id = z.string().min(1).max(64);

const Action = z.discriminatedUnion("action", [
	z.object({ action: z.literal("create"), input: webhookInput }),
	z.object({ action: z.literal("update"), id, patch: webhookPatch }),
	z.object({ action: z.literal("delete"), id }),
	z.object({ action: z.literal("rotate"), id }),
	z.object({ action: z.literal("test"), id }),
]);

/** No caching: this names where the workspace's mail is told of, and changes at any moment. */
function answer(body: WebhookAnswer, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** The workspace's mailboxes, by name. */
async function mailboxesOf(workspaceId: string) {
	return db
		.select({ id: schema.mailbox.id, name: schema.mailbox.name })
		.from(schema.mailbox)
		.where(eq(schema.mailbox.organizationId, workspaceId))
		.orderBy(schema.mailbox.name, schema.mailbox.id)
		.all();
}

/**
 * What the webhooks page shows, with the names of the agents that made their own. The caller must
 * be an owner or admin of the workspace.
 */
export async function readWebhooks(workspaceId: string): Promise<WorkspaceWebhooks> {
	const stub = webhooksStub(workspaceId);
	// Not those of a key revoked, or an agent deleted, while the object was out of reach.
	await stub.prune();
	const [listed, mailboxes] = await Promise.all([stub.list(ADMIN), mailboxesOf(workspaceId)]);
	const made = [...new Set(listed.webhooks.flatMap((hook) => hook.agentMemberId ?? []))];
	const { member, user } = schema;
	const agents: WorkspaceWebhooks["agents"] = [];
	// D1 binds at most 100 values in a statement.
	for (let at = 0; at < made.length; at += 90) {
		const rows = await db
			.select({ memberId: member.id, name: user.name })
			.from(member)
			.innerJoin(user, eq(member.userId, user.id))
			.where(
				and(eq(member.organizationId, workspaceId), inArray(member.id, made.slice(at, at + 90))),
			)
			.all();
		agents.push(...rows);
	}
	return { ...listed, mailboxes, agents };
}

/**
 * `POST /api/webhooks/<workspace>`: adds, changes, pauses, tests or deletes a webhook, or gives it
 * a new secret. Only an owner or admin may: webhooks tell of every mailbox's mail, and their
 * secrets sign it. Of one an agent made for itself, they may pause, resume, test or delete it.
 */
export async function changeWebhooks(request: Request, slug: string): Promise<Response> {
	// A session cookie comes along wherever a request is from, so ask where that is.
	if (request.headers.get("origin") !== appOrigin()) {
		return answer({ ok: false, error: "Not allowed from there." }, 403);
	}
	const member = await currentMember(slug);
	// The same whether the workspace doesn't exist or the caller isn't in it.
	if (!member) return answer({ ok: false, error: "Not found" }, 404);
	if (!isAdminRole(member.membership.role)) {
		return answer({ ok: false, error: "Only an owner or admin can manage webhooks." }, 403);
	}
	const parsed = Action.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		const first = parsed.error.issues[0];
		return answer({ ok: false, error: first?.message ?? "That isn't a change we know." }, 400);
	}
	const { workspaceId } = member.membership;
	const link: WebhookLink = { workspaceId, slug, origin: appOrigin() };
	const hooks = webhooksStub(workspaceId);
	const change = parsed.data;
	const userId = member.user.id;
	/** Notes in an agent's log what this admin did to a webhook it made, when an agent made it. */
	const noteAgentsHook = async (
		agentMemberId: string | null,
		action: "webhook.changed" | "webhook.deleted" | "webhook.tested",
		targetId: string,
		detail: string | null = null,
	) => {
		if (agentMemberId === null) return;
		const by = { userId };
		await noteAgent(db, { workspaceId, agentMemberId, by, action, targetId, detail });
	};
	switch (change.action) {
		case "create": {
			const unknown = await unknownMailbox(workspaceId, change.input.mailboxIds);
			if (unknown) return unknown;
			return reply(await hooks.create(link, change.input, ADMIN));
		}
		case "update": {
			const unknown = await unknownMailbox(workspaceId, change.patch.mailboxIds);
			if (unknown) return unknown;
			const changed = await hooks.update(link, change.id, change.patch, ADMIN);
			// Of an agent's own, an admin only pauses or resumes it.
			if (changed.ok && change.patch.active !== undefined) {
				const detail = change.patch.active ? "resumed" : "paused";
				await noteAgentsHook(changed.webhook.agentMemberId, "webhook.changed", change.id, detail);
			}
			return reply(changed);
		}
		case "delete": {
			const removed = await hooks.remove(change.id, ADMIN);
			if (!removed.ok) return reply(removed);
			await noteAgentsHook(removed.agentMemberId, "webhook.deleted", change.id);
			return reply({ ok: true });
		}
		case "rotate":
			return reply(await hooks.rotate(change.id, ADMIN));
		case "test": {
			const queued = await hooks.test(link, change.id, ADMIN);
			if (!queued.ok) return reply(queued);
			await noteAgentsHook(queued.agentMemberId, "webhook.tested", change.id);
			return reply({ ok: true });
		}
	}
}

/** A refusal when a webhook would name a mailbox the workspace doesn't have. */
async function unknownMailbox(
	workspaceId: string,
	mailboxIds: string[] | null | undefined,
): Promise<Response | null> {
	if (!mailboxIds) return null;
	const found = await db
		.select({ id: schema.mailbox.id })
		.from(schema.mailbox)
		.where(
			and(eq(schema.mailbox.organizationId, workspaceId), inArray(schema.mailbox.id, mailboxIds)),
		)
		.all();
	if (found.length === mailboxIds.length) return null;
	return answer({ ok: false, error: "The workspace has no such mailbox." }, 404);
}

/** An answer from the webhook object, as the page takes it. */
function reply(result: { ok: true } | Refused): Response {
	if (result.ok) return answer(result);
	return answer({ ok: false, error: result.error }, result.status);
}
