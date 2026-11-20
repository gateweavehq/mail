import { env } from "cloudflare:workers";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { isAllowedRecipient, normalTarget, waitsForApproval } from "../../lib/agent-policy";
import {
	canSendAgain,
	isAddress,
	MAX_ATTACHMENTS,
	MAX_CONTEXT_LABEL,
	MAX_CONTEXT_URL,
	MAX_FILE_NAME,
	MAX_HTML,
	MAX_RECIPIENTS,
	MAX_SEND_BODY,
	MAX_SUBJECT,
	MAX_TEXT,
	SENDER_CHECK_PENDING,
	type SendStatus,
	sentContext,
} from "../../lib/outbox";
import { isAdminRole, isPersonRole } from "../../lib/roles";
import { type Suppression, suppressedRefusal } from "../../lib/suppressions";
import { bearsKey } from "../access";
import { type AgentLogNote, noteAgent } from "../agent-log";
import { db } from "../auth";
import {
	AGENT_PAUSED,
	AGENT_ROLE,
	agentPolicyOf,
	agentStanding,
	pausedAmong,
} from "../auth/agents";
import { schema } from "../db";
import { DEFAULT_DNS_RESOLVER, dnsLookup } from "../directory/dns";
import { appOrigin } from "../origin";
import { sendingWith } from "../providers/keys";
import { allowAgentSend, allowSend } from "../rate-limit";
import { readUpTo, textOf } from "../streams";
import { suppressedAmong } from "../suppressions";
import { toRole } from "../workspaces";
import {
	addressHeader,
	dateHeader,
	headerText,
	inCopyOrder,
	type Outgoing,
	plainName,
	rawCopy,
	sendRequest,
} from "./compose";
import { staysInWorkspace, workspaceRecipients } from "./direct";
import { discloseAgent } from "./disclosure";
import type { Sent } from "./durable-object";
import { checkFiles } from "./files";
import { firstHeader, type Header, parseHeaders, readHeaderBlock } from "./headers";
import { sendableHtml } from "./html";
import { mailboxStub } from "./index";
import { newOwnId } from "./own-id";
import { decoded } from "./people";
import { openMailbox, otherGrantedMailboxes } from "./read";
import { rawMail, SealError } from "./sealed";
import { envelopeAddresses, replySender, senderAddresses } from "./senders";
import { textOfHtml } from "./text";
import { messageIds, ownId } from "./thread";

const Id = z.string().min(1).max(100);

/** An address someone types. `isAddress` takes no spaces or line breaks, so none reach a header. */
const Address = z.string().trim().refine(isAddress);

const actions = (address: z.ZodType<string, string>) =>
	z.discriminatedUnion("action", [
		z.object({
			action: z.literal("send"),
			to: z.array(address).min(1).max(MAX_RECIPIENTS),
			cc: z.array(address).max(MAX_RECIPIENTS).default([]),
			// A line break in a header would start another, so none gets in.
			subject: z
				.string()
				.trim()
				.min(1)
				.max(MAX_SUBJECT)
				.refine((subject) => !/[\r\n]/.test(subject)),
			/** Without text, the HTML's makes it; one of the two says something. */
			text: z.string().max(MAX_TEXT).default(""),
			html: z.string().max(MAX_HTML).nullable().default(null),
			/** Checked by `checkFiles` once the rest is known to be well formed. */
			attachments: z
				.array(
					z.object({
						filename: z.string().max(MAX_FILE_NAME * 2),
						contentType: z.string().max(200).nullable().optional(),
						content: z.string().max(MAX_SEND_BODY),
						contentId: z.string().max(200).nullable().optional(),
					}),
				)
				.max(MAX_ATTACHMENTS)
				.default([]),
			/** The message it answers, in this mailbox. */
			replyTo: Id.nullable().default(null),
			/**
			 * One of the mailbox's addresses, which is all it is compared with. Without one, the one a
			 * reply's message came to, or the first.
			 */
			from: z.string().trim().toLowerCase().max(254).nullable().default(null),
			/**
			 * The draft's own id, made when it was opened. A send with one the mailbox has seen is the
			 * same message again, as when its answer was lost, and isn't sent twice.
			 */
			draft: z.uuid(),
			/**
			 * The template an agent's message was made from, as `send_template` says, for the agent's log
			 * to name beside whom it went to. Only the log reads it, and the log shows it as the agent's.
			 */
			template: z
				.object({ name: z.string().max(100), version: z.number().int().min(1).max(1_000_000) })
				.nullable()
				.default(null),
			/** What it was written for, as its writer says. Checked by `sentContext`. */
			context: z
				.object({
					url: z.string().max(MAX_CONTEXT_URL * 2),
					label: z
						.string()
						.max(MAX_CONTEXT_LABEL * 4)
						.nullable()
						.optional(),
				})
				.nullable()
				.default(null),
		}),
		z.object({ action: z.literal("send-again"), message: Id }),
		z.object({ action: z.literal("discard"), message: Id }),
		/** Sends a message an agent wrote that waits for a person. */
		z.object({ action: z.literal("approve"), message: Id }),
	]);

const Action = actions(Address);
const AgentAction = actions(
	z
		.string()
		.trim()
		.transform((address) => (isAddress(address) ? address : (normalTarget(address) ?? "")))
		.pipe(Address),
);

export type OutboxAction = z.input<typeof Action>;

function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

const refuse = (error: string, status: number) => answer({ ok: false, error }, status);

/**
 * A send refused for addresses on the workspace's suppression list, which it names, saying why only
 * to owners and admins, who may see the list.
 */
const refuseSuppressed = (found: Suppression[], withReasons: boolean) =>
	answer(
		{
			ok: false,
			error: suppressedRefusal(found, withReasons),
			suppressed: found.map(({ address }) => address),
		},
		409,
	);

/** Who a message the mailbox keeps went to, as its envelope has them. */
const recipientsOf = (row: { envelopeTo: string }) =>
	row.envelopeTo
		.split(",")
		.map((address) => address.trim())
		.filter(Boolean);

export type AgentReply = "sent" | { proved: boolean; senderDomain: string | null };

/**
 * Sends from a mailbox, tries again, approves or discards, for
 * `POST /api/mail/<workspace>/<mailbox>/outbox`. A person who may read the mailbox may, signed in.
 * An agent may only send, with its key, from a mailbox it was let send from, as its policy allows:
 * on its own, or waiting for a person to approve it, all of it or what goes to anyone its policy
 * doesn't name. Mail to its own workspace's addresses alone never waits.
 *
 * `given` is the body already read, as the agents' API hands it over: a message's files would
 * otherwise be written out and read again.
 */
export async function outboxAnswer(
	request: Request,
	slug: string,
	mailboxId: string,
	given?: unknown,
	// Only the reply operation supplies this, after reading the targets from the stored message.
	reply?: AgentReply,
): Promise<Response> {
	// A key decides alone, as `currentCaller` has it, and no browser sends one by itself. A
	// session's cookie comes along wherever a request is from, so then ask where that is.
	const keyed = bearsKey(request.headers);
	if (!keyed && request.headers.get("origin") !== appOrigin()) {
		return refuse("Not allowed from there", 403);
	}
	const box = await openMailbox(slug, mailboxId, { people: !keyed });
	if (!box) return refuse("Not found", 404);
	let body: unknown = given ?? null;
	if (given === undefined) {
		// Read only so far, whatever the request says its length is, as files make a send large.
		const read = await readUpTo(request.body, MAX_SEND_BODY);
		if (!read) return refuse(TOO_LARGE, 413);
		try {
			body = JSON.parse(textOf(read));
		} catch {
			body = null;
		}
	}
	const parsed = (keyed ? AgentAction : Action).safeParse(body);
	if (!parsed.success) return refuse("That isn't something we can send.", 400);
	const action = parsed.data;
	const { workspaceId, memberId, role } = box.member.membership;
	// A key is an agent's. Agents never sign in, so a session is a person's, whatever its role: one
	// given the agent's role by hand, or one this version doesn't know, reads only with a grant.
	const agent = keyed;
	if (agent && action.action !== "send") {
		return refuse("An agent only sends. People approve, send again and discard.", 403);
	}
	if (agent && !box.agentMaySend) {
		return refuse("This agent may read this mailbox but not send from it.", 403);
	}

	if (action.action === "discard") {
		// Discarding deletes the copy, which only owners and admins may do to someone else's mail.
		// Anyone who reads the mailbox may reject what waits for approval, as they may approve it.
		const row = await box.stub.get(action.message);
		const writerOrAdmin = !row || row.sentBy === memberId || isAdminRole(role);
		if (!writerOrAdmin && !isHeld(row)) {
			return refuse("Only who wrote it, or an owner or admin, can discard it.", 403);
		}
		if (!(await box.stub.discard(action.message, !writerOrAdmin, memberId))) {
			return refuse("Only a message that hasn't reached anyone can be discarded.", 409);
		}
		// Only an agent's mail waits for approval, so discarding it is rejecting what it wrote.
		if (row?.sentBy && isHeld(row)) {
			await noteAgent(db, heldNote(row.sentBy, row, "message.rejected", box, workspaceId));
		}
		return answer({ ok: true });
	}

	if (action.action === "approve") {
		// Counted as it goes, as what a person sends is, so only once it is known to wait. The object
		// still sends it only from `held`, should two people approve it at once.
		const row = await box.stub.get(action.message);
		if (!row || !isHeld(row)) return refuse("It isn't waiting for approval any more.", 409);
		// An address may have come onto the list while it waited.
		const suppressed = await suppressedAmong(db, workspaceId, recipientsOf(row), Date.now());
		if (suppressed.length > 0) return refuseSuppressed(suppressed, isAdminRole(role));
		const allowed = await allowSend(workspaceId);
		if (!allowed.allowed) return tooMany(allowed.retryAfter);
		const status = await box.stub.approve(action.message, memberId);
		if (!status) return refuse("It isn't waiting for approval any more.", 409);
		if (row.sentBy) {
			await noteAgent(db, heldNote(row.sentBy, row, "message.approved", box, workspaceId));
		}
		return answer({ ok: true, ...status });
	}

	if (action.action === "send-again") {
		const row = await box.stub.get(action.message);
		if (row && canSendAgain(statusOf(row))) {
			const suppressed = await suppressedAmong(db, workspaceId, recipientsOf(row), Date.now());
			if (suppressed.length > 0) return refuseSuppressed(suppressed, isAdminRole(role));
		}
		// Counted before it is known to go, as only the object can say, at once.
		const allowed = await allowSend(workspaceId);
		if (!allowed.allowed) return tooMany(allowed.retryAfter);
		const status = await box.stub.sendAgain(action.message, memberId);
		return status ? answer({ ok: true, ...status }) : refuse("It is sent, or being sent.", 409);
	}

	let recipients = [...action.to, ...action.cc];
	if (recipients.length > MAX_RECIPIENTS) {
		return refuse(`One message can go to at most ${MAX_RECIPIENTS} people.`, 400);
	}
	let lower = recipients.map((address) => address.toLowerCase());
	if (new Set(lower).size !== lower.length) return refuse("An address is there twice.", 400);
	// Whoever approves an agent's message sees its HTML, so its text is made from that, not written
	// beside it to say something else.
	if (agent && action.text.trim() && action.html?.trim()) {
		return refuse(
			"Give text or HTML, not both: Mail makes the text from the HTML, so that whoever approves it sees all that goes.",
			400,
		);
	}
	// Kept to what the page shows of it, so the copy shows what goes.
	const cleaned = action.html?.trim() ? await sendableHtml(action.html, { agent }) : null;
	const html = cleaned?.trim() ? cleaned : null;
	const files = checkFiles(action.attachments, { html: html !== null });
	if (!files.ok) return refuse(files.error, 400);
	const context = action.context ? sentContext(action.context) : null;
	if (typeof context === "string") return refuse(context, 400);
	// What a reader without HTML sees, made from the HTML when none was written.
	const text =
		action.text.trim() || html === null
			? action.text
			: (await textOfHtml(html)).text.slice(0, MAX_TEXT);
	if (!text.trim()) return refuse("There is nothing to send: write some text or HTML.", 400);

	const from = await senderAddresses(workspaceId, box.id);
	let answering: Answering = { sentBy: null, inReplyTo: null, references: [], addresses: [] };
	if (action.replyTo) {
		const found = await answered(box.stub, action.replyTo);
		if (!found) return refuse("The message you are answering is gone.", 404);
		answering = found;
	}
	const sender = action.from
		? from.find((address) => address === action.from)
		: replySender(answering.addresses, from);
	if (!sender) {
		return action.from
			? refuse("This mailbox can't send from that address.", 400)
			: refuse("This mailbox has no address on a proved domain to send from.", 409);
	}
	// A draft sent before, as when its answer was lost, is what became of it, and counts once.
	const earlier = await box.stub.drafted(action.draft);
	if (earlier) return sentAnswer(earlier);
	// Made before anything is counted, so that should it fail, nothing is used up.
	const ownMessageId = await newOwnId(env.BETTER_AUTH_SECRET, box.id, sender);
	// Before anything is stored, so the draft stays as it is to be put right. A person's is asked
	// before anything is counted; an agent's once its own day has counted it, below, so that a key
	// can't learn who is on the list for free.
	const checkList = async () => {
		const suppressed = await suppressedAmong(db, workspaceId, lower, Date.now());
		return suppressed.length > 0 ? refuseSuppressed(suppressed, isAdminRole(role)) : null;
	};
	if (!agent) {
		const refused = await checkList();
		if (refused) return refused;
	}
	// Its domain says how it goes. Asked before anything is counted, as a mistake shouldn't use up
	// the day's allowance.
	const way = await sendingWith(db, workspaceId, sender);
	const provider = way?.sendsWith ?? "cloudflare";
	if (provider === "resend" && !way?.keyed) {
		return refuse(
			"This address's domain sends through Resend, and this workspace has no Resend key. An owner or admin can add one in Settings, under Domains.",
			409,
		);
	}
	// An agent's mail goes on its own or waits for a person as its policy says, and counts against
	// its own day either way.
	let hold = false;
	let agentName: string | null = null;
	if (agent) {
		// Asked again here, as reading and cleaning a large message takes a while: a pause meanwhile
		// stops it before it goes.
		const { member, user } = schema;
		const [policy, paused, writer] = await Promise.all([
			agentPolicyOf(db, memberId),
			pausedAmong(db, [memberId]),
			db
				.select({ name: user.name })
				.from(member)
				.innerJoin(user, eq(member.userId, user.id))
				.where(and(eq(member.id, memberId), eq(member.role, AGENT_ROLE)))
				.get(),
		]);
		if (paused.size > 0) return refuse(AGENT_PAUSED, 403);
		if (!writer) return refuse("Not found", 404);
		agentName = writer.name;
		if (policy.sendPerDay === 0) {
			return refuse("This agent isn't let send mail. An owner or admin can change that.", 403);
		}
		const received = reply === "sent" ? undefined : reply;
		if (received?.proved && policy.approval !== "never") {
			action.cc = [];
			recipients = [...action.to];
			lower = recipients.map((address) => address.toLowerCase());
		}
		let keepSentTargets = reply === "sent";
		if (
			keepSentTargets &&
			!policy.anyRecipient &&
			policy.approval === "never" &&
			answering.sentBy !== memberId
		) {
			const author =
				answering.sentBy &&
				(await db
					.select({ role: member.role })
					.from(member)
					.where(and(eq(member.id, answering.sentBy), eq(member.organizationId, workspaceId)))
					.get());
			keepSentTargets = Boolean(author && isPersonRole(toRole(author.role)));
		}
		if (
			!policy.anyRecipient &&
			!keepSentTargets &&
			(policy.approval === "never" || received?.proved === false)
		) {
			// On unproved mail with a single From, the reply's To is that sender.
			let targets = lower;
			if (
				received &&
				(policy.approval !== "never" || (!received.proved && received.senderDomain))
			) {
				targets = action.cc.map((address) => address.toLowerCase());
			} else if (received?.proved && received.senderDomain) {
				const domain = `@${received.senderDomain}`;
				targets = lower.filter((address) => !normalTarget(address)?.endsWith(domain));
			}
			const { outside, pending } = await refusedRecipients(box, sender, targets, policy.allowed);
			if (pending) return refuse(SENDER_CHECK_PENDING, 503);
			// Drop copied strangers before counting the reply. A refused To still stops it.
			if (reply && outside.size) {
				action.cc = action.cc.filter((address) => !outside.has(address.toLowerCase()));
				recipients = [...action.to, ...action.cc];
				lower = recipients.map((address) => address.toLowerCase());
			}
			const refused = lower.filter((address) => outside.has(address));
			if (refused.length) {
				const names = refused.join(", ");
				await noteAgent(db, {
					workspaceId,
					agentMemberId: memberId,
					by: "agent",
					action: "message.refused",
					mailboxId: box.id,
					subject: action.subject,
					detail:
						refused.slice(0, 5).join(", ") +
						(refused.length > 5 ? ` and ${refused.length - 5} more` : ""),
				});
				return refuse(
					`This agent cannot send to ${names}. An owner or admin can add the address or @domain to the agent's allowed list, or allow any recipient in its settings.`,
					403,
				);
			}
			const standing = await agentStanding(db, memberId);
			if (standing === "paused") return refuse(AGENT_PAUSED, 403);
			if (standing === "gone") return refuse("Not found", 404);
		}
		const counted = await allowAgentSend(memberId, policy.sendPerDay);
		if (!counted.allowed) return tooMany(counted.retryAfter, "This agent has written");
		const refused = await checkList();
		if (refused) return refused;
		hold = waitsForApproval(policy, recipients);
		// Mail that stays inside its own workspace reaches nobody outside, so it waits for no one,
		// unless its policy is from before that was so. Asked once the day has counted it, so that a
		// key learns nothing of the directory for free, and only of mail that would wait.
		if (hold && !policy.insideWaits) {
			const from = { address: sender, mailboxId: box.id, workspaceId };
			try {
				const lookUp = dnsLookup(env.DNS_RESOLVER_URL || DEFAULT_DNS_RESOLVER);
				hold = !(await staysInWorkspace(db, lookUp, from, lower, new Date()));
			} catch (error) {
				// It waits, as its policy says of mail it can't tell to be the workspace's own.
				console.error("mailbox: D1 didn't say whether an agent's mail stays in its workspace", {
					name: error instanceof Error ? error.name : "unknown",
				});
			}
			// That look asks D1 and DNS, which takes a while, so the pause is asked once more of mail
			// it lets go: what would have waited for a person must not leave after the agent was
			// stopped, or deleted, which takes its pause with it. A pause that lands after this still
			// finds the message on its way, as one that lands after any send does.
			if (!hold) {
				const standing = await agentStanding(db, memberId);
				if (standing === "paused") return refuse(AGENT_PAUSED, 403);
				// As a revoked key is refused: its agent is no more.
				if (standing === "gone") return refuse("Not found", 404);
			}
		}
	}
	// Counted once the message could go, so a mistake doesn't use up the day's allowance. One that
	// waits is counted when it is approved.
	if (!hold) {
		const allowed = await allowSend(workspaceId);
		if (!allowed.allowed) return tooMany(allowed.retryAfter);
	}

	// What goes into its headers is only what Email Service takes; what threads its copy is all.
	const message: Outgoing = {
		from: { name: box.name, email: sender },
		to: action.to,
		cc: action.cc,
		// A tab or other control character pasted in becomes a space.
		subject: plainName(action.subject),
		...(agentName === null ? { text, html } : discloseAgent(agentName, text, html, hold)),
		files: files.files,
		inReplyTo: headerSafe(answering.inReplyTo),
		references: answering.references.filter(isHeaderSafe),
		ownId: ownMessageId,
	};
	const date = new Date();
	// Headers as the copy has them, unfolded, which is how arriving mail's are kept.
	const unfolded = (value: string) => value.replace(/\r\n /g, " ");
	const sent = await box.stub.send({
		workspaceId,
		mailboxId: box.id,
		sentBy: memberId,
		raw: rawCopy(message, date),
		from: unfolded(addressHeader(message.from)),
		subject: unfolded(headerText(message.subject)),
		date: dateHeader(date),
		envelopeFrom: sender,
		envelopeTo: [...message.to, ...message.cc].join(", "),
		ownId: message.ownId,
		references: answering.references,
		request: sendRequest(message),
		files: inCopyOrder(files.files).map(({ content: _content, ...file }) => file),
		provider,
		draft: action.draft,
		hold,
		context,
	});
	if (agent && sent.ok) {
		await noteAgent(db, {
			workspaceId,
			agentMemberId: memberId,
			by: "agent",
			action: sent.state === "held" ? "message.held" : "message.sent",
			mailboxId: box.id,
			targetId: sent.id,
			threadId: sent.threadId,
			subject: message.subject,
			detail: action.template
				? `template ${action.template.name}, version ${action.template.version}: ${recipients.join(", ")}`
				: recipients.join(", "),
			context,
		});
	}
	return sentAnswer(sent);
}

/** Only mail retained in a mailbox the agent may still read can establish a correspondent. */
async function refusedRecipients(
	box: NonNullable<Awaited<ReturnType<typeof openMailbox>>>,
	sender: string,
	recipients: string[],
	allowed: string[],
) {
	const unknown = new Set(recipients.filter((address) => !isAllowedRecipient(address, allowed)));
	if (!unknown.size) return { outside: unknown, pending: false };
	const { workspaceId } = box.member.membership;
	const lookUp = dnsLookup(env.DNS_RESOLVER_URL || DEFAULT_DNS_RESOLVER);
	const from = { address: sender, mailboxId: box.id, workspaceId };
	const now = new Date();
	const first = await box.stub.receivedFrom([...unknown]);
	const pending = new Set(first.pending);
	for (const found of first.found) unknown.delete(found);
	if (!unknown.size) return { outside: unknown, pending: false };
	for (const address of await workspaceRecipients(db, lookUp, from, [...unknown], now, pending)) {
		unknown.delete(address);
	}
	if (!unknown.size) return { outside: unknown, pending: false };
	const other = await otherGrantedMailboxes(box);
	for (let i = 0; i < other.length && unknown.size; i += 5) {
		const wanted = [...unknown];
		const matches = await Promise.all(
			other.slice(i, i + 5).map((id) => mailboxStub(id).receivedFrom(wanted)),
		);
		for (const match of matches) {
			for (const address of match.found) unknown.delete(address);
			for (const address of match.pending) pending.add(address);
		}
	}
	return { outside: unknown, pending: [...unknown].some((address) => pending.has(address)) };
}

/** An entry, for the log of the agent that wrote it, of what a person did to a held message. */
function heldNote(
	writer: string,
	row: { id: string; threadId: string; subject: string | null },
	action: "message.approved" | "message.rejected",
	box: { id: string; member: { userId: string } },
	workspaceId: string,
): AgentLogNote {
	return {
		workspaceId,
		agentMemberId: writer,
		by: { userId: box.member.userId },
		action,
		mailboxId: box.id,
		targetId: row.id,
		threadId: row.threadId,
		subject: decoded(row.subject),
	};
}

const TOO_LARGE =
	"That is too large to send: a request takes 16 MB at most, and a message's files 10 MB together.";

function sentAnswer(sent: Sent): Response {
	if (sent.ok) return answer(sent);
	return sent.reason === "full"
		? refuse("The mailbox is full. Delete some mail, then send again.", 409)
		: refuse("It is still being saved. Look in the thread in a moment.", 409);
}

/** How a message the mailbox keeps is being sent, or null for one that came in. */
const statusOf = (row: { sending: string | null } | null) =>
	row?.sending ? (JSON.parse(row.sending) as SendStatus) : null;

/** Whether a message waits for a person to approve it. */
const isHeld = (row: { sending: string | null } | null) => statusOf(row)?.state === "held";

function tooMany(retryAfter: number | null | undefined, who = "This workspace has sent"): Response {
	const hours = Math.max(1, Math.round((retryAfter ?? 0) / 3600));
	return answer(
		{
			ok: false,
			error: `${who} as much as it may for now. Try again in about ${hours === 1 ? "an hour" : `${hours} hours`}.`,
			// In seconds, for an agent's API to pass on as Retry-After.
			retryAfter: retryAfter ?? null,
		},
		429,
	);
}

/** What a reply takes from the message it answers. */
interface Answering {
	sentBy: string | null;
	inReplyTo: string | null;
	/** The ids it follows, oldest first, ending with the answered message's own. */
	references: string[];
	/** The addresses it was to and from, lower case, which a reply may go from. */
	addresses: string[];
}

/**
 * What threads a reply to this message of the mailbox, read from the message's own headers, as
 * RFC 5322 says: its `References`, or failing those its `In-Reply-To`, then its own id. Null when
 * there is no such message here.
 */
async function answered(
	stub: ReturnType<typeof mailboxStub>,
	messageId: string,
): Promise<Answering | null> {
	const row = await stub.get(messageId);
	if (!row) return null;
	let headers: Header[];
	try {
		const object = await rawMail(env).get(row);
		if (!object) return null;
		headers = parseHeaders(await readHeaderBlock(object.body));
	} catch (error) {
		if (!(error instanceof SealError)) throw error;
		// Its own id is in its row, which still threads the reply, without the ids before it.
		const own = messageIds(row.messageId)[0] ?? null;
		return {
			sentBy: row.sentBy,
			inReplyTo: own,
			references: own ? [own] : [],
			addresses: envelopeAddresses(row),
		};
	}
	const own = ownId(headers);
	// Whole, as a long thread's runs past what `firstHeader` keeps.
	const before = messageIds(headers.find((header) => header.name === "references")?.value ?? null);
	const followed =
		before.length > 0 ? before : messageIds(firstHeader(headers, "in-reply-to")).slice(0, 1);
	const references = [...new Set([...followed, ...(own ? [own] : [])])];
	return { sentBy: row.sentBy, inReplyTo: own, references, addresses: envelopeAddresses(row) };
}

/**
 * Whether an id from arriving mail can go into a header Mail sends: printable ASCII only, as RFC
 * 5322 has it. Anything else would have Email Service refuse every reply to that message.
 */
const isHeaderSafe = (id: string) => /^[\x21-\x7e]+$/.test(id);

const headerSafe = (id: string | null) => (id !== null && isHeaderSafe(id) ? id : null);
