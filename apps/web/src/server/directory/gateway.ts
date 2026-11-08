import { env } from "cloudflare:workers";
import { z } from "zod";
import { RECEIVES_WITH, SENDS_WITH } from "../../lib/providers";
import { isAdminRole } from "../../lib/roles";
import { currentCaller, currentMember } from "../access";
import { db } from "../auth";
import { removeMailboxes } from "../mailbox";
import { appOrigin } from "../origin";
import { allowDomainCheck } from "../rate-limit";
import { dropUnusedReceivingWebhook, mendReceiving, setDomainReceiving } from "../resend-inbound";
import { DEFAULT_DNS_RESOLVER, dnsLookup } from "./dns";
import {
	addAddress,
	addDomain,
	addMailbox,
	checkDomain,
	listDirectory,
	MAX_MAILBOX_READERS,
	removeAddress,
	removeDomain,
	removeMailbox,
	setDomainSending,
	setMailboxAccess,
} from "./index";

const Id = z.string().min(1).max(64);

const Action = z.discriminatedUnion("action", [
	z.object({ action: z.literal("add-domain"), name: z.string().max(300) }),
	z.object({ action: z.literal("check-domain"), id: Id }),
	z.object({ action: z.literal("remove-domain"), id: Id }),
	z.object({ action: z.literal("check-receiving") }),
	z.object({
		action: z.literal("set-domain-sending"),
		id: Id,
		sendsWith: z.enum(SENDS_WITH),
	}),
	z.object({
		action: z.literal("set-domain-receiving"),
		id: Id,
		receivesWith: z.enum(RECEIVES_WITH),
	}),
	z.object({
		action: z.literal("add-mailbox"),
		name: z.string().max(300),
		everyone: z.boolean().default(false),
	}),
	z.object({
		action: z.literal("set-mailbox-access"),
		mailboxId: Id,
		everyone: z.boolean(),
		memberIds: z.array(Id).max(MAX_MAILBOX_READERS),
		/** Those of them, agents, that may send from it too. */
		senderIds: z.array(Id).max(MAX_MAILBOX_READERS).default([]),
	}),
	z.object({ action: z.literal("remove-mailbox"), id: Id }),
	z.object({
		action: z.literal("add-address"),
		domainId: Id,
		mailboxId: Id,
		localPart: z.string().max(300),
		expiresInDays: z.number().int().min(1).max(365).nullable(),
	}),
	z.object({ action: z.literal("remove-address"), id: Id }),
]);

export type DirectoryAction = z.input<typeof Action>;

/** No caching: this holds who a workspace is, and what it says can change at any moment. */
function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** The same whether the workspace doesn't exist or the caller isn't in it. */
const notFound = () => answer({ ok: false, error: "Not found" }, 404);

/** What the caller may see of the directory. An agent sees the mailboxes it was given. */
export async function readDirectory(slug: string): Promise<Response> {
	const member = await currentCaller(slug);
	if (!member) return notFound();
	const { workspaceId, memberId, role } = member.membership;
	return answer(await listDirectory(db, workspaceId, { memberId, role }));
}

export async function changeDirectory(request: Request, slug: string): Promise<Response> {
	// A session cookie comes along wherever a request is from, so ask where that is.
	if (request.headers.get("origin") !== appOrigin()) {
		return answer({ ok: false, error: "Not allowed from there" }, 403);
	}
	const member = await currentMember(slug);
	if (!member) return notFound();
	const { workspaceId, role } = member.membership;
	if (!isAdminRole(role)) {
		return answer({ ok: false, error: "Only an owner or admin can change this." }, 403);
	}
	const parsed = Action.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return answer({ ok: false, error: "That isn't a change we know." }, 400);

	const result = await run(parsed.data, workspaceId, member.user.id);
	return answer(result, result.ok ? 200 : result.status);
}

async function run(action: z.output<typeof Action>, workspaceId: string, userId: string) {
	const now = new Date();
	switch (action.action) {
		case "add-domain":
			return addDomain(db, workspaceId, action.name);
		case "check-domain":
			if (!(await allowDomainCheck(workspaceId))) {
				return {
					ok: false as const,
					error: "That's a lot of checks. Wait a minute, as DNS takes a while to change anyway.",
					status: 429 as const,
				};
			}
			return checkDomain(
				db,
				workspaceId,
				action.id,
				dnsLookup(env.DNS_RESOLVER_URL || DEFAULT_DNS_RESOLVER),
				now,
			);
		case "remove-domain": {
			const result = await removeDomain(db, workspaceId, action.id);
			if (result.ok) await dropUnusedReceivingWebhook(db, workspaceId);
			return result;
		}
		case "set-domain-sending":
			return setDomainSending(db, workspaceId, action.id, action.sendsWith);
		case "set-domain-receiving":
			return setDomainReceiving(db, workspaceId, action.id, action.receivesWith, appOrigin());
		case "check-receiving":
			return mendReceiving(db, workspaceId, appOrigin());
		case "add-mailbox":
			return addMailbox(db, workspaceId, action.name, action.everyone);
		case "set-mailbox-access":
			return setMailboxAccess(db, workspaceId, userId, action);
		case "remove-mailbox": {
			const result = await removeMailbox(db, workspaceId, action.id);
			if (result.ok) await removeMailboxes(workspaceId, [action.id]);
			return result;
		}
		case "add-address":
			return addAddress(db, workspaceId, userId, action, now);
		case "remove-address":
			return removeAddress(db, workspaceId, action.id);
	}
}
