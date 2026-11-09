import { z } from "zod";
import { MAX_AGENT_ADDRESS_DAYS } from "../../lib/agent-addresses";
import {
	type ListedMessage,
	MAX_QUERY_SENT,
	type MessageCursor,
	type OpenedMessage,
	type ThreadCursor,
} from "../../lib/mailbox";
import { MAX_RECIPIENTS, MAX_SUBJECT, MAX_TEXT } from "../../lib/outbox";
import { findVerificationCode } from "../../lib/verification-code";
import {
	type AgentMailbox,
	type Answer,
	ApiError,
	type FailureStatus,
	findMailbox,
	gone,
	InternalFailure,
	type MailAccess,
} from "./mail-access";
import { OUTPUTS, READ_MESSAGE, READ_THREAD } from "./outputs";
import { UNTRUSTED } from "./untrusted";
import { domainOf, MAX_WAIT_SECONDS, WAIT_SECONDS, waitFor } from "./wait";

// What an agent can do with Mail, each defined once: its input and output, its words, and where it
// is over REST. Mail's MCP tools, its REST routes under /api/v1 and their OpenAPI document are all
// made from these, so none of them can drift from the others.

/** An HTTP method a route answers. */
export type Method = "GET" | "POST" | "DELETE";

/** Where an operation is over REST. */
export interface Route {
	method: Method;
	/** Its path under /api/v1, with each `{name}` an input taken from the path. */
	path: string;
	/** Its OpenAPI operationId: the operation's name, unless the operation has two routes. */
	id?: string;
	/** Its OpenAPI summary: the operation's title, unless the operation has two routes. */
	summary?: string;
	/** The inputs, besides the path's, this route takes: all of them unless these are named. */
	takes?: string[];
	/** Its answer, when narrower than the operation's. */
	output?: z.ZodObject;
}

/** What an MCP client is told about a tool, beside its words. */
export interface Hints {
	readOnlyHint: boolean;
	destructiveHint?: boolean;
	openWorldHint: boolean;
}

export interface Operation {
	/** The MCP tool's name, and the OpenAPI operationId of its route. */
	name: string;
	title: string;
	description: string;
	input: z.ZodObject;
	output: z.ZodObject;
	hints: Hints;
	routes: Route[];
	/** The statuses its routes may answer besides 200, 400, 401, 404 and 500. */
	refusals: FailureStatus[];
	/** Does it, for input that `input` parsed: the MCP SDK and the REST routes both parse first. */
	run(
		access: MailAccess,
		input: Record<string, unknown>,
		signal: AbortSignal,
	): Promise<Record<string, unknown>>;
}

function operation<S extends z.ZodRawShape>(
	defined: Omit<Operation, "input" | "run"> & {
		input: z.ZodObject<S>;
		run(
			access: MailAccess,
			input: z.output<z.ZodObject<S>>,
			signal: AbortSignal,
		): Promise<Record<string, unknown>>;
	},
): Operation {
	return {
		...defined,
		run: (access, input, signal) => defined.run(access, input as z.output<z.ZodObject<S>>, signal),
	};
}

const mailboxInput = z
	.string()
	.trim()
	.min(1)
	.max(300)
	.describe("The mailbox's id, its name, or one of its addresses, from list_mailboxes.");
const cursorInput = z
	.string()
	.max(200)
	.describe("The next value of the page before, to go on to older mail.");
const idInput = z.string().min(1).max(100);
const addressInput = z.string().trim().min(3).max(254).toLowerCase();
const addressesInput = z.array(addressInput).max(MAX_RECIPIENTS);
const textInput = z
	.string()
	.max(MAX_TEXT)
	.refine((text) => text.trim().length > 0, "The text is empty.")
	.describe("Plain text.");
const draftInput = z
	.uuid()
	.describe(
		"A UUID of your own for this message. Send again with the same one, as after a timeout, and it isn't sent twice.",
	);
/** A sender, as an address or a domain; "@example.com" is the domain. */
const senderInput = z
	.string()
	.trim()
	.toLowerCase()
	.min(1)
	.max(255)
	.transform((sender) => sender.replace(/^@/, ""))
	.pipe(z.string().min(1).max(254));
const waitInput = {
	mailbox: mailboxInput.optional().describe("The mailbox. Give it, or `to`, or both."),
	to: addressInput
		.optional()
		.describe(
			"Only mail that came to this address, which also says the mailbox. Give it, or `mailbox`, or both.",
		),
	from: senderInput
		.optional()
		.describe(
			"Only mail from this address, or from this domain or one under it, such as github.com.",
		),
	subject: z
		.string()
		.trim()
		.min(1)
		.max(200)
		.optional()
		.describe("Only mail whose subject has these words, ignoring case."),
	provedOnly: z
		.boolean()
		.optional()
		.describe(
			"Only mail whose From's domain DMARC proved (verifiedDomain), so a forged From is passed over. With from, proved to be that sender's.",
		),
	since: z.iso
		.datetime({ offset: true })
		.optional()
		.describe(
			"Only mail that arrived at or after this time, ISO 8601. Without it, mail from the 5 minutes before the call counts too, such as an earlier code: pass the time just before you asked for the mail.",
		),
	timeoutSeconds: z
		.number()
		.int()
		.min(0)
		.max(MAX_WAIT_SECONDS)
		.optional()
		.describe(`How long to wait for it, ${WAIT_SECONDS} seconds unless you say.`),
};

const listMailboxes = operation({
	name: "list_mailboxes",
	title: "List mailboxes",
	description:
		"Lists the mailboxes you may read, with their addresses and whether you may send from each, and your limits: where your mail goes without a person approving it, and which addresses you may make. Start here.",
	input: z.object({}),
	output: OUTPUTS.list_mailboxes,
	hints: { readOnlyHint: true, openWorldHint: false },
	routes: [{ method: "GET", path: "/mailboxes" }],
	refusals: [],
	async run(access) {
		const [mailboxes, { sending, addresses }] = await Promise.all([
			access.mailboxes(),
			access.policies(),
		]);
		return {
			mailboxes: mailboxes.map((box) => ({
				id: box.id,
				name: box.name,
				addresses: box.addresses.map(addressOf),
				maySend: box.maySend,
			})),
			sending: { perDay: sending.sendPerDay, withoutApproval: sending.allowed },
			addressPolicy: addresses,
		};
	},
});

const searchEmail = operation({
	name: "search_email",
	title: "Search email",
	description: `Lists a mailbox's threads, the newest news first, or with a query those with a message that has every word of it. Read one with read_email. ${UNTRUSTED}`,
	input: z.object({
		mailbox: mailboxInput,
		query: z.string().trim().max(MAX_QUERY_SENT).optional().describe("Words to look for."),
		cursor: cursorInput.optional(),
	}),
	output: OUTPUTS.search_email,
	hints: { readOnlyHint: true, openWorldHint: false },
	routes: [{ method: "GET", path: "/mailboxes/{mailbox}/threads" }],
	refusals: [],
	async run(access, { mailbox, query, cursor }) {
		const box = await findMailbox(access, mailbox);
		const page = gone(await access.threads(box.id, threadCursor(cursor), query ? query : null));
		return {
			threads: page.threads.map((thread) => ({
				id: thread.id,
				subject: thread.subject,
				senders: thread.senders,
				latestAt: iso(thread.latestAt),
				count: thread.count,
				latestVerifiedDomain: thread.latestVerifiedDomain,
			})),
			next: page.next ? `${page.next.latestAt}.${page.next.id}` : null,
			untrusted: UNTRUSTED,
		};
	},
});

const readEmail = operation({
	name: "read_email",
	title: "Read email",
	description: `Reads one message, by messageId, or a thread, by threadId: its messages, newest last, with the newest opened. ${UNTRUSTED}`,
	input: z.object({
		mailbox: mailboxInput,
		messageId: idInput.optional(),
		threadId: idInput.optional(),
		cursor: cursorInput.optional().describe("For a thread, its older messages."),
	}),
	output: OUTPUTS.read_email,
	hints: { readOnlyHint: true, openWorldHint: false },
	routes: [
		{
			method: "GET",
			path: "/mailboxes/{mailbox}/messages/{messageId}",
			summary: "Read message",
			takes: [],
			output: READ_MESSAGE,
		},
		{
			method: "GET",
			path: "/mailboxes/{mailbox}/threads/{threadId}",
			id: "read_thread",
			summary: "Read thread",
			takes: ["cursor"],
			output: READ_THREAD,
		},
	],
	refusals: [],
	async run(access, { mailbox, messageId, threadId, cursor }) {
		if (Boolean(messageId) === Boolean(threadId)) {
			throw new ApiError("Give a messageId or a threadId, one of them.", 400);
		}
		const box = await findMailbox(access, mailbox);
		if (messageId) {
			const message = await access.message(box.id, messageId);
			if (!message) throw new ApiError("No such message in this mailbox.", 404);
			return { message: messageOf(message) };
		}
		const thread = await access.thread(box.id, threadId ?? "", messageCursor(cursor));
		if (!thread) throw new ApiError("No such thread in this mailbox.", 404);
		return {
			thread: {
				id: threadId,
				subject: thread.subject,
				count: thread.count,
				messages: thread.messages.map(summaryOf),
				latest: thread.latest ? messageOf(thread.latest) : null,
				older: thread.older ? `${thread.older.arrivedAt}.${thread.older.id}` : null,
			},
		};
	},
});

const waitForEmail = operation({
	name: "wait_for_email",
	title: "Wait for email",
	description: `Waits for mail to come to a mailbox, such as a confirmation after you signed up somewhere, and opens the newest that matches. Mail that came in the 5 minutes before the call counts too, unless you pass since. Gives found: false when none came in time; call again to wait longer. For a sign-in or confirmation code, get_verification_code reads less of the message. ${UNTRUSTED}`,
	input: z.object(waitInput),
	output: OUTPUTS.wait_for_email,
	hints: { readOnlyHint: true, openWorldHint: false },
	routes: [{ method: "GET", path: "/wait" }],
	refusals: [429],
	async run(access, input, signal) {
		const { box, found } = await waitFor(access, input, signal);
		if (!found) return { found: false };
		const message = await access.message(box.id, found.id);
		if (!message) throw new ApiError("The message was deleted as it was opened.", 404);
		return { found: true, message: messageOf(message) };
	},
});

const getVerificationCode = operation({
	name: "get_verification_code",
	title: "Get verification code",
	description:
		"Waits for a sign-up, sign-in or confirmation message from a sender you name, as wait_for_email does, and gives only the one-time code in it, never the rest of its text. Only mail whose sender DMARC proved counts, unless you pass provedOnly: false, as a From can be forged. Pass since, the time just before you asked for the code, so an earlier one isn't taken. code is null when the message has no code it could tell apart.",
	input: z.object({
		...waitInput,
		from: senderInput.describe(
			"Who sends the code: an address, or a domain such as github.com, which takes one under it too.",
		),
		provedOnly: waitInput.provedOnly.describe(
			"false to take mail whose sender wasn't proved too. Leave it out unless the sender's mail fails DMARC.",
		),
	}),
	output: OUTPUTS.get_verification_code,
	hints: { readOnlyHint: true, openWorldHint: false },
	routes: [{ method: "GET", path: "/verification-code" }],
	refusals: [429],
	async run(access, input, signal) {
		const wait = { ...input, provedOnly: input.provedOnly ?? true };
		const { box, found } = await waitFor(access, wait, signal);
		if (!found) return { found: false };
		const message = await access.message(box.id, found.id);
		if (!message) throw new ApiError("The message was deleted as it was opened.", 404);
		return {
			found: true,
			code: findVerificationCode(message.subject, message.text),
			messageId: message.id,
			// Only a domain's letters: the part before the @ is the sender's to write.
			fromDomain: domainOf(message.from?.address ?? ""),
			verifiedDomain: message.verifiedDomain,
			dmarc: message.dmarc,
			arrivedAt: iso(message.arrivedAt),
		};
	},
});

const sendEmail = operation({
	name: "send_email",
	title: "Send email",
	description:
		"Sends a plain-text message from a mailbox you may send from. Mail to anyone your policy doesn't name waits for a person to approve it (state: held), and counts against your messages a day either way.",
	input: z.object({
		mailbox: mailboxInput,
		to: addressesInput.min(1).describe(`To and cc together take ${MAX_RECIPIENTS} at most.`),
		cc: addressesInput.optional().describe(`To and cc together take ${MAX_RECIPIENTS} at most.`),
		subject: z.string().trim().min(1).max(MAX_SUBJECT),
		text: textInput,
		from: addressInput
			.optional()
			.describe("One of the mailbox's addresses; the first unless you say."),
		draftId: draftInput.optional(),
	}),
	output: OUTPUTS.send_email,
	hints: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	routes: [{ method: "POST", path: "/mailboxes/{mailbox}/messages" }],
	refusals: [403, 409, 429],
	async run(access, { mailbox, to, cc, subject, text, from, draftId }) {
		const box = await findMailbox(access, mailbox);
		return sent(
			await access.outbox(box.id, {
				action: "send",
				to,
				cc: cc ?? [],
				subject,
				text,
				from: from ?? null,
				draft: draftId ?? crypto.randomUUID(),
			}),
		);
	},
});

const reply = operation({
	name: "reply",
	title: "Reply",
	description:
		"Answers a message in its thread, to whoever it asks answers to go to, from the address it came to. Waits for approval as send_email does.",
	input: z.object({
		mailbox: mailboxInput,
		messageId: idInput,
		text: textInput,
		draftId: draftInput.optional(),
	}),
	output: OUTPUTS.reply,
	hints: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	routes: [{ method: "POST", path: "/mailboxes/{mailbox}/messages/{messageId}/reply" }],
	refusals: [403, 409, 429],
	async run(access, { mailbox, messageId, text, draftId }) {
		const box = await findMailbox(access, mailbox);
		const message = await access.message(box.id, messageId);
		if (!message) throw new ApiError("No such message in this mailbox.", 404);
		const { reply } = message;
		if (reply.to.length === 0) throw new ApiError("The message names nobody to answer.", 409);
		return sent(
			await access.outbox(box.id, {
				action: "send",
				to: reply.to,
				cc: reply.cc,
				subject: reply.subject,
				text,
				replyTo: message.id,
				from: reply.from,
				draft: draftId ?? crypto.randomUUID(),
			}),
		);
	},
});

const listAddresses = operation({
	name: "list_addresses",
	title: "List addresses",
	description: "Lists the live addresses you made in a mailbox, and how many you have in all.",
	input: z.object({ mailbox: mailboxInput }),
	output: OUTPUTS.list_addresses,
	hints: { readOnlyHint: true, openWorldHint: false },
	routes: [{ method: "GET", path: "/mailboxes/{mailbox}/addresses" }],
	refusals: [],
	async run(access, { mailbox }) {
		const box = await findMailbox(access, mailbox);
		const { body } = answered(await access.addresses(box.id, null));
		const addresses = (body.addresses ?? []) as AgentMailbox["addresses"];
		return { addresses: addresses.map(addressOf), live: body.live };
	},
});

const createAddress = operation({
	name: "create_address",
	title: "Create address",
	description:
		"Makes an address of your own for a mailbox you may send from, on a domain your policy names, such as one to sign up somewhere with. It takes mail at once and ends after the days you ask for, at most your policy's. Without localPart it gets a random one. A name in use, or used in the last 30 days, can't be had.",
	input: z.object({
		mailbox: mailboxInput,
		domain: z.string().trim().min(1).max(253).toLowerCase(),
		localPart: z.string().trim().min(1).max(64).optional().describe("What goes before the @."),
		days: z.number().int().min(1).max(MAX_AGENT_ADDRESS_DAYS).optional(),
	}),
	output: OUTPUTS.create_address,
	hints: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
	routes: [{ method: "POST", path: "/mailboxes/{mailbox}/addresses" }],
	refusals: [403, 409],
	async run(access, { mailbox, domain, localPart, days }) {
		const box = await findMailbox(access, mailbox);
		const { body } = answered(
			await access.addresses(box.id, {
				action: "make",
				domain,
				localPart: localPart ?? null,
				days: days ?? null,
			}),
		);
		return addressOf(body.address as AgentMailbox["addresses"][number]);
	},
});

const endAddress = operation({
	name: "end_address",
	title: "End address",
	description:
		"Ends an address you made, at once: mail to it is refused from then on. Its name can't be made again for 30 days.",
	input: z.object({
		mailbox: mailboxInput,
		addressId: idInput.describe("Its id, from list_addresses."),
	}),
	output: OUTPUTS.end_address,
	hints: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
	routes: [{ method: "DELETE", path: "/mailboxes/{mailbox}/addresses/{addressId}" }],
	refusals: [],
	async run(access, { mailbox, addressId }) {
		const box = await findMailbox(access, mailbox);
		answered(await access.addresses(box.id, { action: "end", id: addressId }));
		return { ended: true };
	},
});

/** Everything an agent can do, in the order its tools and routes are listed. */
export const OPERATIONS: readonly Operation[] = [
	listMailboxes,
	searchEmail,
	readEmail,
	waitForEmail,
	getVerificationCode,
	sendEmail,
	reply,
	listAddresses,
	createAddress,
	endAddress,
];

const iso = (ms: number) => new Date(ms).toISOString();

function messageCursor(cursor: string | undefined): MessageCursor | null {
	const parsed = cursorOf(cursor);
	return parsed && { arrivedAt: parsed.at, id: parsed.id };
}

function threadCursor(cursor: string | undefined): ThreadCursor | null {
	const parsed = cursorOf(cursor);
	return parsed && { latestAt: parsed.at, id: parsed.id };
}

/** A cursor as a page's `next` gave it: a time, a point, an id. */
function cursorOf(cursor: string | undefined): { at: number; id: string } | null {
	if (!cursor) return null;
	const match = /^(\d{1,15})\.(.{1,100})$/.exec(cursor);
	if (!match?.[1] || !match[2]) throw new ApiError("That cursor isn't one a page gave.", 400);
	return { at: Number(match[1]), id: match[2] };
}

function addressOf(address: AgentMailbox["addresses"][number]) {
	return {
		id: address.id,
		address: address.address,
		expiresAt: address.expiresAt === null ? null : iso(address.expiresAt),
	};
}

function summaryOf(message: ListedMessage) {
	return {
		id: message.id,
		threadId: message.threadId,
		arrivedAt: iso(message.arrivedAt),
		from: message.from,
		subject: message.subject,
		verifiedDomain: message.verifiedDomain,
		cameTo: message.cameTo,
		sent: message.sent ? { state: message.sent.status?.state ?? null } : null,
	};
}

function messageOf(message: OpenedMessage) {
	return {
		id: message.id,
		threadId: message.threadId,
		arrivedAt: iso(message.arrivedAt),
		from: message.from,
		to: message.to,
		cc: message.cc,
		subject: message.subject,
		date: message.date,
		verifiedDomain: message.verifiedDomain,
		dmarc: message.dmarc,
		text: message.text,
		textCut: message.textCut,
		attachments: message.attachments,
		sent: message.sent
			? {
					state: message.sent.status?.state ?? null,
					code: message.sent.status?.code ?? null,
					deliveries: message.sent.deliveries,
				}
			: null,
		untrusted: UNTRUSTED,
	};
}

const FAILURES: readonly number[] = [400, 403, 404, 409, 429] satisfies FailureStatus[];

/** A route's answer when it did what was asked; its own words, and status, for why not. */
function answered(answer: Answer): Answer {
	if (answer.status >= 200 && answer.status < 300 && answer.body.ok !== false) return answer;
	// A route's own failure is Mail's, not the caller's to put right.
	if (answer.status >= 500) throw new InternalFailure(`an agent's route answered ${answer.status}`);
	const error = typeof answer.body.error === "string" ? answer.body.error : "That didn't work.";
	const status = (FAILURES.includes(answer.status) ? answer.status : 400) as FailureStatus;
	const retryAfter = typeof answer.body.retryAfter === "number" ? answer.body.retryAfter : null;
	throw new ApiError(
		error === "Not found" ? "No such mailbox or address of yours." : error,
		status,
		retryAfter,
	);
}

/** What became of a message the outbox took. */
function sent(answer: Answer) {
	const { body } = answered(answer);
	return { id: body.id, threadId: body.threadId, state: body.state };
}
