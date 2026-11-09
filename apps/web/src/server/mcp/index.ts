import { createMcpHandler } from "@modelcontextprotocol/server";
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
import { type Answer, createMailServer, type MailAccess } from "./tools";

/**
 * Mail's MCP server at `/mcp`, for an agent with its key. It is a gateway like the agent's REST
 * routes, and every tool goes through the same functions they do, as the same key: the request's
 * own `Authorization` is what `currentCaller` reads. So a key reaches only the workspace it was
 * made for and the mailboxes it was given, and what it sends waits for a person as its policy has
 * it. Session cookies are never enough here: without a key the answer is 401, whatever comes with
 * it.
 */
export async function handleMcpRequest(request: Request): Promise<Response> {
	const key = /^Bearer\s+(\S+)$/i.exec(request.headers.get("authorization")?.trim() ?? "")?.[1];
	const agent = key && isAgentKey(key) ? await findAgentByKey(db, key) : null;
	if (!key || !agent) return unauthorized(key !== undefined);
	return mcpHandler.fetch(request, {
		authInfo: {
			token: key,
			// One id per agent, whichever key it uses.
			clientId: `agent:${agent.userId}`,
			scopes: [],
			extra: { slug: agent.slug },
		},
	});
}

const mcpHandler = createMcpHandler(({ authInfo }) => {
	const slug = authInfo?.extra?.slug;
	// `handleMcpRequest` only lets a found key through, and always names its workspace.
	if (typeof slug !== "string" || !authInfo?.token) {
		throw new Error("MCP request without a verified key");
	}
	return createMailServer(accessFor(slug, authInfo.token));
});

/** A JSON-RPC error, as an MCP client reads one, for a request without a working key. */
function unauthorized(hadKey: boolean): Response {
	return Response.json(
		{
			jsonrpc: "2.0",
			error: {
				code: -32000,
				message: hadKey
					? "That agent key doesn't work: it was revoked, or its agent deleted."
					: "Mail's MCP server takes an agent's key, as a bearer token. An owner or admin makes one in the workspace's settings, under Agents.",
			},
			id: null,
		},
		{
			status: 401,
			headers: {
				// No resource metadata: there is no OAuth here that a key could be swapped for.
				"WWW-Authenticate": hadKey
					? 'Bearer realm="Gateweave Mail", error="invalid_token"'
					: 'Bearer realm="Gateweave Mail"',
				"cache-control": "no-store",
			},
		},
	);
}

/** What the agent with this key may do, in its workspace, as its REST routes let it. */
function accessFor(slug: string, key: string): MailAccess {
	const caller = async () => {
		const found = await currentCaller(slug);
		// Revoked since the request began, or its agent removed.
		if (!found) throw new Error("The agent's key no longer works");
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
