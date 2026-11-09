import { z } from "zod";
import { MAX_AGENT_ADDRESS_DAYS } from "../../lib/agent-addresses";
import {
	type ListedMessage,
	MAX_QUERY_SENT,
	type MessageCursor,
	type OpenedMessage,
	type ThreadCursor,
} from "../../lib/mailbox";
import {
	MAX_ATTACHMENTS,
	MAX_FILE_NAME,
	MAX_HTML,
	MAX_RECIPIENTS,
	MAX_SEND_BODY,
	MAX_SUBJECT,
	MAX_TEXT,
} from "../../lib/outbox";
import { findVerificationCode } from "../../lib/verification-code";
import {
	MAX_AGENT_WEBHOOKS,
	MAX_WEBHOOK_MAILBOXES,
	type Webhook,
	type WebhookDelivery,
	webhookInput,
} from "../../lib/webhooks";
import {
	type AgentMailbox,
	type Answer,
	ApiError,
	type FailureStatus,
	findMailbox,
	gone,
	InternalFailure,
	type MailAccess,
	pickMailbox,
} from "./mail-access";
import { OUTPUTS, READ_MESSAGE, READ_THREAD } from "./outputs";
import { UNTRUSTED } from "./untrusted";
import { domainOf, MAX_WAIT_SECONDS, WAIT_SECONDS, waitFor } from "./wait";

// What an agent can do with Mail, each defined once: its input and output, its words, and where it
// is over REST. Mail's MCP tools, its REST routes under /api/v1 and their OpenAPI document are all
// made from these, so none of them can drift from the others.

/** An HTTP method a route answers. POST and PATCH take a JSON body, the others a query. */
export type Method = "GET" | "POST" | "PATCH" | "DELETE";

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
	/** The most bytes its REST body may hold, when it is more than the 1 MB every other takes. */
	maxBody?: number;
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
	.describe("Plain text. With html, leave it out to have it made from the html.");
const htmlInput = z
	.string()
	.max(MAX_HTML)
	.describe(
		'The message as HTML, beside its text. Show an attached image with <img src="cid:…"> and the image\'s contentId.',
	);
const attachmentsInput = z
	.array(
		z.object({
			filename: z
				.string()
				.trim()
				.min(1)
				.max(MAX_FILE_NAME)
				.describe("The file's name, as whoever gets it sees it."),
			contentType: z
				.string()
				.trim()
				.max(127)
				.optional()
				.describe(
					"Its media type, such as application/pdf. From the name's extension if left out.",
				),
			content: z.string().min(1).describe("The file's bytes in Base64."),
			contentId: z
				.string()
				.trim()
				.min(1)
				.max(100)
				.optional()
				.describe(
					"For an image the html shows: the id its cid: names, such as logo. Leave it out for a file to attach.",
				),
		}),
	)
	.max(MAX_ATTACHMENTS)
	.describe(
		`Files it carries, ${MAX_ATTACHMENTS} at most and 10 MB together. Mail doesn't send kinds of file many mail servers refuse, such as .exe, .js, .bat or .msi.`,
	);
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

const webhookIdInput = idInput.describe("Its id, from list_webhooks.");
const webhookUrlInput = webhookInput.shape.url.describe(
	"Where Mail posts each event: an https URL, never Mail's own.",
);
const webhookEventsInput = webhookInput.shape.events.describe(
	"What it hears of. message.received: mail came to the mailbox. message.held: mail written waits for a person to approve it. message.rejected: a person rejected it. message.sent: it went to the provider. message.delivered, message.bounced and message.complained: a recipient's server took it, refused it, or marked it as spam, told once for each recipient. Of mail you write, you aren't told of what you did yourself (holding it, or sending what needed no approval), only of what people and servers did.",
);
const webhookMailboxesInput = z
	.array(mailboxInput)
	.min(1)
	.max(MAX_WEBHOOK_MAILBOXES)
	.nullable()
	.describe(
		"The mailboxes it hears of, by id, name or address, from list_mailboxes; null for every mailbox you may read, those you are given later too.",
	);

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
		"Sends a message from a mailbox you may send from: text, HTML or both, with files if you like. Mail to anyone your policy doesn't name waits for a person to approve it (state: held), and counts against your messages a day either way.",
	input: z.object({
		mailbox: mailboxInput,
		to: addressesInput.min(1).describe(`To and cc together take ${MAX_RECIPIENTS} at most.`),
		cc: addressesInput.optional().describe(`To and cc together take ${MAX_RECIPIENTS} at most.`),
		subject: z.string().trim().min(1).max(MAX_SUBJECT),
		text: textInput.optional(),
		html: htmlInput.optional(),
		attachments: attachmentsInput.optional(),
		from: addressInput
			.optional()
			.describe("One of the mailbox's addresses; the first unless you say."),
		draftId: draftInput.optional(),
	}),
	output: OUTPUTS.send_email,
	hints: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	routes: [{ method: "POST", path: "/mailboxes/{mailbox}/messages" }],
	refusals: [403, 409, 429],
	maxBody: MAX_SEND_BODY,
	async run(access, { mailbox, to, cc, subject, text, html, attachments, from, draftId }) {
		const box = await findMailbox(access, mailbox);
		return sent(
			await access.outbox(box.id, {
				action: "send",
				to,
				cc: cc ?? [],
				subject,
				text: text ?? "",
				html: html ?? null,
				attachments: attachments ?? [],
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
		"Answers a message in its thread, to whoever it asks answers to go to, from the address it came to: text, HTML or both, with files if you like. Waits for approval as send_email does.",
	input: z.object({
		mailbox: mailboxInput,
		messageId: idInput,
		text: textInput.optional(),
		html: htmlInput.optional(),
		attachments: attachmentsInput.optional(),
		draftId: draftInput.optional(),
	}),
	output: OUTPUTS.reply,
	hints: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	routes: [{ method: "POST", path: "/mailboxes/{mailbox}/messages/{messageId}/reply" }],
	refusals: [403, 409, 429],
	maxBody: MAX_SEND_BODY,
	async run(access, { mailbox, messageId, text, html, attachments, draftId }) {
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
				text: text ?? "",
				html: html ?? null,
				attachments: attachments ?? [],
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

const listWebhooks = operation({
	name: "list_webhooks",
	title: "List webhooks",
	description: `Lists the webhooks you made, with each one's latest deliveries and how they went. You may have ${MAX_AGENT_WEBHOOKS}.`,
	input: z.object({}),
	output: OUTPUTS.list_webhooks,
	hints: { readOnlyHint: true, openWorldHint: false },
	routes: [{ method: "GET", path: "/webhooks" }],
	refusals: [],
	async run(access) {
		const { webhooks, deliveries } = await access.webhooks();
		return {
			webhooks: webhooks.map((hook) => ({
				...webhookOf(hook),
				deliveries: deliveries.filter((delivery) => delivery.webhookId === hook.id).map(deliveryOf),
			})),
			max: MAX_AGENT_WEBHOOKS,
		};
	},
});

const createWebhook = operation({
	name: "create_webhook",
	title: "Create webhook",
	description:
		"Makes a webhook of your own, so you hear of mail without waiting for it: Mail posts each event you choose, of mailboxes you may read, to your https URL, and tries again for about a day while it fails. Each POST is signed per Standard Webhooks (webhook-id, webhook-timestamp and webhook-signature headers) with the secret this answer gives, once: keep it. A body is { type, timestamp, data }, and data names the workspace, the mailbox and the message, never its text, which read_email gives; what senders wrote comes marked as such, and members are given by id, not by name. A mailbox you may no longer read goes quiet, and the webhook goes when the key you make it with is revoked. Test it with test_webhook.",
	input: z.object({
		url: webhookUrlInput,
		events: webhookEventsInput,
		mailboxes: webhookMailboxesInput.optional(),
	}),
	output: OUTPUTS.create_webhook,
	hints: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	routes: [{ method: "POST", path: "/webhooks" }],
	refusals: [409],
	async run(access, { url, events, mailboxes }) {
		const mailboxIds = await mailboxIdsOf(access, mailboxes ?? null);
		const { webhook, secret } = await access.createWebhook({ url, events, mailboxIds });
		return { webhook: webhookOf(webhook), secret };
	},
});

const updateWebhook = operation({
	name: "update_webhook",
	title: "Update webhook",
	description:
		"Changes a webhook of yours: where it goes, what it hears of, or whether it is active. Pausing it drops what it had yet to deliver; taking a mailbox or an event off it drops what waited for those. One an admin paused (pausedByAdmin) only an admin resumes. With newSecret: true it gets a new secret, which this answer gives once, and signs what it sends from then on with it, retries too.",
	input: z.object({
		webhookId: webhookIdInput,
		url: webhookUrlInput.optional(),
		events: webhookEventsInput.optional(),
		mailboxes: webhookMailboxesInput.optional(),
		active: z.boolean().optional().describe("false to pause it, true to resume it."),
		newSecret: z.boolean().optional().describe("true for a new secret."),
	}),
	output: OUTPUTS.update_webhook,
	hints: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
	routes: [{ method: "PATCH", path: "/webhooks/{webhookId}" }],
	refusals: [409],
	async run(access, { webhookId, url, events, mailboxes, active, newSecret }) {
		const changes = url !== undefined || events !== undefined || mailboxes !== undefined;
		if (!changes && active === undefined && !newSecret) {
			throw new ApiError("Give what to change: url, events, mailboxes, active or newSecret.", 400);
		}
		const mailboxIds = mailboxes === undefined ? undefined : await mailboxIdsOf(access, mailboxes);
		const { webhook, secret } = await access.updateWebhook(
			webhookId,
			{ url, events, mailboxIds, active },
			newSecret ?? false,
		);
		return secret === null
			? { webhook: webhookOf(webhook) }
			: { webhook: webhookOf(webhook), secret };
	},
});

const deleteWebhook = operation({
	name: "delete_webhook",
	title: "Delete webhook",
	description: "Deletes a webhook of yours, and what it had yet to deliver.",
	input: z.object({ webhookId: webhookIdInput }),
	output: OUTPUTS.delete_webhook,
	hints: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
	routes: [{ method: "DELETE", path: "/webhooks/{webhookId}" }],
	refusals: [],
	async run(access, { webhookId }) {
		await access.deleteWebhook(webhookId);
		return { deleted: true };
	},
});

const testWebhook = operation({
	name: "test_webhook",
	title: "Test webhook",
	description:
		"Has a webhook of yours post a webhook.test event, whatever it listens to, to check that your receiver gets it and checks its signature. One at a time, while it is active; see how it went with list_webhooks.",
	input: z.object({ webhookId: webhookIdInput }),
	output: OUTPUTS.test_webhook,
	hints: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
	routes: [{ method: "POST", path: "/webhooks/{webhookId}/test" }],
	refusals: [409],
	async run(access, { webhookId }) {
		await access.testWebhook(webhookId);
		return { queued: true };
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
	listWebhooks,
	createWebhook,
	updateWebhook,
	deleteWebhook,
	testWebhook,
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

/** The mailboxes a webhook names, by id, among those the agent may read; null for all of them. */
async function mailboxIdsOf(access: MailAccess, wanted: string[] | null): Promise<string[] | null> {
	if (wanted === null) return null;
	const all = await access.mailboxes();
	return [...new Set(wanted.map((one) => pickMailbox(all, one).id))].sort();
}

function webhookOf(hook: Webhook) {
	return {
		id: hook.id,
		url: hook.url,
		events: hook.events,
		mailboxIds: hook.mailboxIds,
		active: hook.active,
		pausedByAdmin: hook.pausedByAdmin,
		secretStart: hook.secretStart,
		createdAt: iso(hook.createdAt),
		updatedAt: iso(hook.updatedAt),
	};
}

function deliveryOf(delivery: WebhookDelivery) {
	return {
		id: delivery.id,
		event: delivery.event,
		status: delivery.status,
		attempts: delivery.attempts,
		responseStatus: delivery.responseStatus,
		error: delivery.error,
		nextAttemptAt: delivery.nextAttemptAt === null ? null : iso(delivery.nextAttemptAt),
		createdAt: iso(delivery.createdAt),
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
