import { z } from "zod";

// What each of the agent's operations answers, by its MCP tool's name: its MCP output schema, and
// the 200 answer of its REST routes in the OpenAPI document. Only zod here, so tests can read
// answers with these too.

// Outputs are loose objects. MCP clients keep a tool's output schema from when they connected and
// validate results against it, so with a strict schema every field added later would fail their
// calls until they reconnect; REST clients made from the document fare the same.
const personOutput = z.looseObject({ name: z.string(), address: z.string() });
const sentOutput = z
	.looseObject({ state: z.string().nullable() })
	.nullable()
	.describe(
		'For mail the mailbox sent, what became of it: "held" waits for a person to approve it, then "sending", "waiting" (to try again), "sent", "refused", "uncertain" or "discarded".',
	);
const verifiedOutput = z
	.string()
	.nullable()
	.describe("The From's domain, when DMARC proved that domain sent it; null when unproved.");
const summaryOutput = z.looseObject({
	id: z.string(),
	threadId: z.string(),
	arrivedAt: z.string(),
	from: personOutput.nullable(),
	subject: z.string(),
	verifiedDomain: verifiedOutput,
	cameTo: z.array(z.string()).describe("For mail that came in, the address it came to."),
	sent: sentOutput,
});
const messageOutput = z.looseObject({
	id: z.string(),
	threadId: z.string(),
	arrivedAt: z.string(),
	from: personOutput.nullable(),
	to: z.array(personOutput),
	cc: z.array(personOutput),
	subject: z.string(),
	date: z.string().nullable().describe("The Date header, as sent."),
	verifiedDomain: verifiedOutput,
	dmarc: z.string().nullable().describe('The DMARC check\'s verdict, such as "pass" or "fail".'),
	text: z.string().describe("The text, made from the HTML when the message has no text part."),
	textCut: z.boolean(),
	attachments: z.array(
		z.looseObject({ name: z.string().nullable(), type: z.string(), size: z.number() }),
	),
	sent: sentOutput,
	untrusted: z.string(),
});
const sendOutput = z.looseObject({
	id: z.string(),
	threadId: z.string(),
	state: z
		.string()
		.describe(
			'"held" when it waits for a person to approve it, as your policy has mail to anyone else wait; otherwise how sending it went.',
		),
});
const addressOutput = z.looseObject({
	id: z.string(),
	address: z.string(),
	expiresAt: z.string().nullable(),
});

const webhookOutput = z.looseObject({
	id: z.string(),
	url: z.string(),
	events: z.array(z.string()),
	mailboxIds: z
		.array(z.string())
		.nullable()
		.describe("The mailboxes it hears of; null for every mailbox you may read."),
	active: z.boolean(),
	pausedByAdmin: z.boolean().describe("An admin paused it, and only an admin resumes it."),
	secretStart: z.string().describe("The secret's first characters, to tell secrets apart."),
	createdAt: z.string(),
	updatedAt: z.string(),
});
const webhookDeliveryOutput = z.looseObject({
	id: z.string().describe("Its webhook-id header, the same on every retry."),
	event: z.string(),
	status: z.string().describe('"pending" while it is to be tried again, "delivered" or "failed".'),
	attempts: z.number(),
	responseStatus: z
		.number()
		.nullable()
		.describe("What your receiver answered last; null when it didn't, as on a timeout."),
	error: z.string().nullable(),
	nextAttemptAt: z.string().nullable(),
	createdAt: z.string(),
});

const threadOutput = z.looseObject({
	id: z.string(),
	subject: z.string(),
	count: z.number(),
	messages: z.array(summaryOutput).describe("Oldest first."),
	latest: messageOutput.nullable(),
	older: z.string().nullable().describe("Pass as cursor for older messages."),
});

/** read_email's answer on its REST routes, each of which gives one of the two. */
export const READ_MESSAGE = z.looseObject({ message: messageOutput });
export const READ_THREAD = z.looseObject({ thread: threadOutput });

/** Each operation's answer, by its name. */
export const OUTPUTS = {
	list_mailboxes: z.looseObject({
		mailboxes: z.array(
			z.looseObject({
				id: z.string(),
				name: z.string(),
				addresses: z.array(addressOutput),
				maySend: z.boolean(),
			}),
		),
		sending: z.looseObject({
			perDay: z.number().describe("Messages you may write a day; 0 means none."),
			withoutApproval: z
				.array(z.string())
				.describe(
					"Addresses, and domains written @example.com, your mail goes to as it is. Mail to anyone else waits for a person to approve it.",
				),
		}),
		addressPolicy: z.looseObject({
			maxLive: z
				.number()
				.describe("Addresses you may have at once, and make in a day; 0 means none."),
			maxDays: z.number().describe("The longest one of yours may last."),
			domains: z.array(z.string()).describe("The domains you may make them on."),
		}),
	}),
	search_email: z.looseObject({
		threads: z.array(
			z.looseObject({
				id: z.string(),
				subject: z.string(),
				senders: z.array(personOutput).describe("Who wrote in it, the first few."),
				latestAt: z.string(),
				count: z.number(),
				latestVerifiedDomain: z.string().nullable(),
			}),
		),
		next: z.string().nullable().describe("Pass as cursor for older threads."),
		untrusted: z.string(),
	}),
	read_email: z.looseObject({
		message: messageOutput.optional(),
		thread: threadOutput.optional(),
	}),
	get_attachment: z.looseObject({
		filename: z
			.string()
			.describe(
				'The name to save it under: its sender\'s, without path parts, controls or marks that turn text around; "attachment" when it had none.',
			),
		contentType: z.string().describe("The type its sender stated, which proves nothing."),
		size: z.number(),
		content: z.string().describe("The file's bytes, in Base64."),
		untrusted: z.string(),
	}),
	wait_for_email: z.looseObject({ found: z.boolean(), message: messageOutput.optional() }),
	get_verification_code: z.looseObject({
		found: z.boolean(),
		code: z.string().nullable().optional(),
		messageId: z.string().optional(),
		fromDomain: z
			.string()
			.nullable()
			.optional()
			.describe("The domain of the From's address, which on its own proves nothing."),
		verifiedDomain: z
			.string()
			.nullable()
			.optional()
			.describe("The From's domain, when DMARC proved it; null when unproved."),
		dmarc: z.string().nullable().optional(),
		arrivedAt: z.string().optional(),
	}),
	send_email: sendOutput,
	reply: sendOutput,
	list_addresses: z.looseObject({
		addresses: z.array(addressOutput),
		live: z.number().describe("Live addresses you made, in every mailbox."),
	}),
	create_address: addressOutput,
	end_address: z.looseObject({ ended: z.boolean() }),
	list_webhooks: z.looseObject({
		webhooks: z.array(
			webhookOutput.extend({
				deliveries: z.array(webhookDeliveryOutput).describe("The latest, newest first."),
			}),
		),
		max: z.number().describe("How many webhooks you may have."),
	}),
	create_webhook: z.looseObject({
		webhook: webhookOutput,
		secret: z
			.string()
			.describe("The whsec_ secret to check signatures with. Only this answer gives it."),
	}),
	update_webhook: z.looseObject({
		webhook: webhookOutput,
		secret: z
			.string()
			.optional()
			.describe("The new secret, when you asked for one. Only this answer gives it."),
	}),
	delete_webhook: z.looseObject({ deleted: z.boolean() }),
	test_webhook: z.looseObject({ queued: z.boolean() }),
} as const;
