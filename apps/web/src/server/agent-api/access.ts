import { eq } from "drizzle-orm";
import { currentCaller } from "../access";
import { db } from "../auth";
import { agentPolicyOf, findAgentByKey, isAgentKey } from "../auth/agents";
import { schema } from "../db";
import { listDirectory } from "../directory";
import { addressPolicyOf } from "../directory/agent-address-store";
import { type AgentAddressAction, agentAddressesAnswer } from "../directory/agent-addresses";
import { listMessages, listThreads, openMessage, openThread } from "../mailbox/read";
import { type OutboxAction, outboxAnswer } from "../mailbox/send";
import { appOrigin } from "../origin";
import { allowAgentWait } from "../rate-limit";
import { type Answer, ApiError, type MailAccess } from "./mail-access";

/**
 * The agent whose key a request bears as its bearer token, with the key, or why there is none:
 * no key at all, or one that doesn't work. Session cookies never count here.
 */
export async function agentOfRequest(
	request: Request,
): Promise<{ key: string; userId: string; slug: string } | { hadKey: boolean }> {
	const key = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1];
	const agent = key && isAgentKey(key) ? await findAgentByKey(db, key) : null;
	if (!key || !agent) return { hadKey: key !== undefined };
	return { key, userId: agent.userId, slug: agent.slug };
}

/**
 * What the agent with this key may do, in its workspace, as its own routes let it. Every call goes
 * through the functions those routes call, and they read the request's own `Authorization` through
 * `currentCaller`: the key, which the gateway checked, is all that decides.
 */
export function accessFor(slug: string, key: string): MailAccess {
	const caller = async () => {
		const found = await currentCaller(slug);
		// Revoked since the request began, or its agent removed.
		if (!found) {
			throw new ApiError("That agent key doesn't work: it was revoked, or its agent deleted.", 401);
		}
		return found.membership;
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
		return {
			status: response.status,
			body: (await response.json().catch(() => ({}))) as Record<string, unknown>,
		};
	};
	const mailboxPath = (mailboxId: string, rest: string) =>
		`/api/mail/${encodeURIComponent(slug)}/${encodeURIComponent(mailboxId)}/${rest}`;

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
		messages: (mailboxId, before) => listMessages(slug, mailboxId, before),
		threads: (mailboxId, before, query) => listThreads(slug, mailboxId, before, query),
		thread: (mailboxId, threadId, before) => openThread(slug, mailboxId, threadId, before),
		message: (mailboxId, messageId) => openMessage(slug, mailboxId, messageId),
		addresses: (mailboxId, action: AgentAddressAction | null) =>
			ask(
				mailboxPath(mailboxId, "addresses"),
				(request) => agentAddressesAnswer(request, slug, mailboxId),
				action,
			),
		outbox: (mailboxId, action: OutboxAction) =>
			ask(
				mailboxPath(mailboxId, "outbox"),
				(request) => outboxAnswer(request, slug, mailboxId),
				action,
			),
	};
}
