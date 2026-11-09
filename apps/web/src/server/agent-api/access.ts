import { eq } from "drizzle-orm";
import type { AgentLogAction } from "../../lib/agent-log";
import { currentCaller } from "../access";
import { noteAgent } from "../agent-log";
import { db } from "../auth";
import { AGENT_PAUSED, agentPolicyOf, findAgentByKey, isAgentKey } from "../auth/agents";
import { schema } from "../db";
import { listDirectory } from "../directory";
import { addressPolicyOf } from "../directory/agent-address-store";
import { type AgentAddressAction, agentAddressesAnswer } from "../directory/agent-addresses";
import { listMessages, listThreads, openMessage, openThread } from "../mailbox/read";
import { type OutboxAction, outboxAnswer } from "../mailbox/send";
import { appOrigin } from "../origin";
import { allowAgentWait } from "../rate-limit";
import type { Asker, Refused } from "../webhooks";
import { webhooksStub } from "../webhooks";
import { type AgentWebhookPatch, type Answer, ApiError, type MailAccess } from "./mail-access";

/** What an agent is told when its key no longer works. */
const REVOKED = "That agent key doesn't work: it was revoked, or its agent deleted.";

/** The webhooks object's refusal, in its words, with its status. */
const refusal = (refused: Refused) => new ApiError(refused.error, refused.status);

/** Why a request has no agent to act for: no key at all, one that doesn't work, or a paused one. */
export type NoAgent = { hadKey: false } | { hadKey: true; paused: boolean };

/**
 * The agent whose key a request bears as its bearer token, with the key, or why there is none.
 * Session cookies never count here.
 */
export async function agentOfRequest(
	request: Request,
): Promise<{ key: string; userId: string; slug: string } | NoAgent> {
	const key = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1];
	if (key === undefined) return { hadKey: false };
	const agent = isAgentKey(key) ? await findAgentByKey(db, key) : null;
	if (!agent) return { hadKey: true, paused: false };
	if ("paused" in agent) return { hadKey: true, paused: true };
	return { key, userId: agent.userId, slug: agent.slug };
}

/** What a request without an agent to act for is told, and with which status. */
export function noAgentAnswer(
	why: NoAgent,
	without: string,
): { error: string; status: 401 | 403; challenge: string } {
	if (why.hadKey && why.paused) {
		return { error: AGENT_PAUSED, status: 403, challenge: 'Bearer realm="Gateweave Mail"' };
	}
	return why.hadKey
		? {
				error: REVOKED,
				status: 401,
				challenge: 'Bearer realm="Gateweave Mail", error="invalid_token"',
			}
		: { error: without, status: 401, challenge: 'Bearer realm="Gateweave Mail"' };
}

/**
 * What the agent with this key may do, in its workspace, as its own routes let it. Every call goes
 * through the functions those routes call, and they read the request's own `Authorization` through
 * `currentCaller`: the key, which the gateway checked, is all that decides.
 */
export function accessFor(slug: string, key: string): MailAccess {
	/**
	 * Whether the agent was paused since the request began. A route finds no caller then, as for a
	 * key revoked, so this tells the agent which it was: a paused one keeps its key.
	 */
	const pausedSince = async () => {
		const agent = await findAgentByKey(db, key);
		return agent !== null && "paused" in agent;
	};
	const caller = async () => {
		const found = await currentCaller(slug);
		if (!found) {
			if (await pausedSince()) throw new ApiError(AGENT_PAUSED, 403);
			// Revoked since the request began, or its agent removed.
			throw new ApiError(REVOKED, 401);
		}
		return found.membership;
	};
	/** A page a route gave, or none: as the agent may no longer read it, or as it was paused. */
	const unlessPaused = async <T>(page: T | null): Promise<T | null> => {
		if (page === null && (await pausedSince())) throw new ApiError(AGENT_PAUSED, 403);
		return page;
	};
	/** Asks one of the agent's routes, with its key, as its own request would. */
	const ask = async (
		path: string,
		answerOf: (request: Request) => Promise<Response>,
		body: unknown,
	): Promise<Answer> => {
		const request = new Request(`${appOrigin()}${path}`, {
			method: body === null ? "GET" : "POST",
			headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
			...(body === null ? {} : { body: JSON.stringify(body) }),
		});
		const response = await answerOf(request);
		if ((response.status === 401 || response.status === 404) && (await pausedSince())) {
			return { status: 403, body: { ok: false, error: AGENT_PAUSED } };
		}
		return {
			status: response.status,
			body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
		};
	};
	const mailboxPath = (mailboxId: string, rest: string) =>
		`/api/mail/${encodeURIComponent(slug)}/${encodeURIComponent(mailboxId)}/${rest}`;
	/** The workspace's webhooks object, asked as this agent with this key, for its own only. */
	const hooks = async () => {
		const [{ workspaceId, memberId }, agent] = await Promise.all([
			caller(),
			findAgentByKey(db, key),
		]);
		if (!agent) throw new ApiError(REVOKED, 401);
		// Paused after `caller` looked.
		if ("paused" in agent) throw new ApiError(AGENT_PAUSED, 403);
		const asker: Asker = { agent: memberId, key: agent.keyId };
		/** Notes in the agent's log what it did to one of its webhooks. */
		const note = (action: AgentLogAction, id: string, detail: string | null = null) =>
			noteAgent(db, {
				workspaceId,
				agentMemberId: memberId,
				by: "agent",
				action,
				targetId: id,
				detail,
			});
		return {
			stub: webhooksStub(workspaceId),
			asker,
			link: { workspaceId, slug, origin: appOrigin() },
			note,
		};
	};

	return {
		async mailboxes() {
			const { workspaceId, memberId, role } = await caller();
			const now = Date.now();
			const { mailboxAccess } = schema;
			const [directory, grants] = await Promise.all([
				listDirectory(db, workspaceId, { memberId, role }),
				db
					.select({ mailboxId: mailboxAccess.mailboxId, send: mailboxAccess.send })
					.from(mailboxAccess)
					.where(eq(mailboxAccess.memberId, memberId))
					.all(),
			]);
			const sends = new Set(grants.filter((grant) => grant.send).map((grant) => grant.mailboxId));
			return directory.mailboxes.map((box) => ({
				id: box.id,
				name: box.name,
				addresses: box.addresses
					.filter(
						(address) =>
							address.domainProved && (address.expiresAt === null || address.expiresAt > now),
					)
					.map(({ id, address, expiresAt }) => ({ id, address, expiresAt })),
				maySend: sends.has(box.id),
			}));
		},
		async policies() {
			const { memberId } = await caller();
			const [sending, addresses] = await Promise.all([
				agentPolicyOf(db, memberId),
				addressPolicyOf(db, memberId),
			]);
			return { sending, addresses };
		},
		async startWait() {
			const { memberId } = await caller();
			return allowAgentWait(memberId);
		},
		messages: async (mailboxId, before) =>
			unlessPaused(await listMessages(slug, mailboxId, before)),
		threads: async (mailboxId, before, query) =>
			unlessPaused(await listThreads(slug, mailboxId, before, query)),
		thread: async (mailboxId, threadId, before) =>
			unlessPaused(await openThread(slug, mailboxId, threadId, before)),
		message: async (mailboxId, messageId, reading) =>
			unlessPaused(await openMessage(slug, mailboxId, messageId, reading)),
		addresses: (mailboxId, action: AgentAddressAction | null) =>
			ask(
				mailboxPath(mailboxId, "addresses"),
				(request) => agentAddressesAnswer(request, slug, mailboxId),
				action,
			),
		outbox: (mailboxId, action: OutboxAction) =>
			ask(
				mailboxPath(mailboxId, "outbox"),
				// Handed over as it is, as a message's files would be written out and read again.
				(request) => outboxAnswer(request, slug, mailboxId, action),
				{},
			),
		async webhooks() {
			const { stub, asker } = await hooks();
			return stub.list(asker);
		},
		async createWebhook(fields) {
			const { stub, asker, link, note } = await hooks();
			const made = await stub.create(link, fields, asker);
			if (!made.ok) throw refusal(made);
			// Its host, as a URL's path or query can hold a token of the receiver's.
			await note("webhook.made", made.webhook.id, new URL(made.webhook.url).host);
			return { webhook: made.webhook, secret: made.secret };
		},
		async updateWebhook(id, patch, renew) {
			const { stub, asker, link, note } = await hooks();
			const changed = await stub.update(link, id, patch, asker, renew);
			if (!changed.ok) throw refusal(changed);
			await note("webhook.changed", id, webhookChange(patch, renew));
			return { webhook: changed.webhook, secret: changed.secret };
		},
		async deleteWebhook(id) {
			const { stub, asker, note } = await hooks();
			const removed = await stub.remove(id, asker);
			if (!removed.ok) throw refusal(removed);
			await note("webhook.deleted", id);
		},
		async testWebhook(id) {
			const { stub, asker, link, note } = await hooks();
			const queued = await stub.test(link, id, asker);
			if (!queued.ok) throw refusal(queued);
			await note("webhook.tested", id);
		},
	};
}

/** What a change to a webhook was, in a few words, for the agent's log. */
export function webhookChange(patch: AgentWebhookPatch, renew: boolean): string {
	const said = [
		patch.url !== undefined && `where it goes: ${new URL(patch.url).host}`,
		patch.events !== undefined && "what it hears of",
		patch.mailboxIds !== undefined && "its mailboxes",
		patch.active === false && "paused",
		patch.active === true && "resumed",
		renew && "a new secret",
	];
	return said.filter((part) => part !== false).join(", ");
}
