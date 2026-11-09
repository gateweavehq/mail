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
		thread: z
			.looseObject({
				id: z.string(),
				subject: z.string(),
				count: z.number(),
				messages: z.array(summaryOutput).describe("Oldest first."),
				latest: messageOutput.nullable(),
				older: z.string().nullable().describe("Pass as cursor for older messages."),
			})
			.optional(),
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
} as const;
