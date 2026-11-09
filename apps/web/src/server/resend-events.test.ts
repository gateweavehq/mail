import { describe, expect, it } from "vitest";
import { SUPPRESSION_DAYS } from "../lib/suppressions";
import { type EventDirectory, FIND_WINDOW_MS, type Sender } from "./delivery-events";
import type { DeliveryEvent } from "./mailbox/deliveries";
import { readResendEvent, recordResendEvent } from "./resend-events";
import type { NewSuppression } from "./suppressions";

const at = Date.parse("2026-11-09T00:11:01.023Z");

/** Resend's event about one recipient, shaped as the ones measured on 2026-11-09. */
function event(type: string, data: Record<string, unknown> = {}) {
	return {
		type,
		created_at: new Date(at).toISOString(),
		data: {
			created_at: "2026-11-09T00:11:00.500Z",
			email_id: "56761188-7520-42d8-8898-ff6fc54ce618",
			message_id: "<111-222-333@email.example.com>",
			from: "Support <Help@Example.com>",
			to: ["Ada@Example.org"],
			subject: "Hello",
			...data,
		},
	};
}

const bounced = (bounce: Record<string, unknown>) => event("email.bounced", { bounce });

const permanent = (reply: string) => ({
	type: "Permanent",
	subType: "General",
	message: "The recipient's email provider sent a hard bounce message.",
	diagnosticCode: [`smtp; ${reply}`],
});

describe("reading Resend's events about sent mail", () => {
	it("gives the sender, the recipient and what became of it", () => {
		expect(readResendEvent(event("email.delivered"), 0)).toEqual({
			sender: "help@example.com",
			events: [
				{
					event: {
						provider: "resend",
						messageId: "56761188-7520-42d8-8898-ff6fc54ce618",
						recipient: "ada@example.org",
						state: "delivered",
						at,
						detail: null,
					},
					suppression: null,
				},
			],
		});
		const states = [
			["email.delivery_delayed", "deferred"],
			["email.bounced", "bounced"],
			["email.complained", "complained"],
			["email.failed", "failed"],
			["email.suppressed", "rejected"],
		];
		for (const [type, state] of states) {
			expect(readResendEvent(event(type ?? ""), 0)?.events[0]?.event.state).toBe(state);
		}
	});

	it("reads nothing it doesn't record, or can't", () => {
		for (const type of ["email.sent", "email.opened", "email.received", "suppression.added"]) {
			expect(readResendEvent(event(type), 0)).toBeNull();
		}
		expect(readResendEvent(event("email.delivered", { from: "nobody" }), 0)).toBeNull();
		expect(readResendEvent(event("email.delivered", { to: [] }), 0)).toBeNull();
		expect(readResendEvent(event("email.delivered", { email_id: "../x" }), 0)).toBeNull();
		expect(readResendEvent("not an event", 0)).toBeNull();
	});

	it("takes the time it was received for an event without one", () => {
		const timeless = { ...event("email.delivered"), created_at: undefined };
		expect(readResendEvent(timeless, 42)?.events[0]?.event.at).toBe(42);
	});

	it("records each recipient an event names", () => {
		const two = readResendEvent(
			event("email.delivered", {
				to: ["ada@example.org", "Bob <bob@example.org>", "ADA@example.org"],
			}),
			0,
		);
		expect(two?.events.map(({ event }) => event.recipient)).toEqual([
			"ada@example.org",
			"bob@example.org",
		]);
	});

	it("keeps the server's reply, without Resend's `smtp; `, or Resend's words", () => {
		const read = readResendEvent(bounced(permanent("550 5.1.1 User unknown")), 0);
		expect(read?.events[0]?.event.detail).toBe("550 5.1.1 User unknown");
		const wordsOnly = readResendEvent(bounced({ type: "Permanent", message: "Gone." }), 0);
		expect(wordsOnly?.events[0]?.event.detail).toBe("Gone.");
		const kept = readResendEvent(
			event("email.suppressed", {
				suppressed: { type: "Suppressed", reason: "previous_bounce", message: "On the list." },
			}),
			0,
		);
		expect(kept?.events[0]?.event.detail).toBe("On the list.");
		const failed = readResendEvent(
			event("email.failed", { failed: { reason: "reached_daily_quota" } }),
			0,
		);
		expect(failed?.events[0]?.event.detail).toBe("reached_daily_quota");
	});

	it("stops mail after a complaint, and a permanent bounce, for good when the mailbox doesn't exist", () => {
		const said = (body: unknown) => readResendEvent(body, 0)?.events[0]?.suppression;
		expect(said(event("email.complained"))).toEqual({ reason: "complained", forever: true });
		expect(said(bounced(permanent("550 5.1.1 User unknown")))).toEqual({
			reason: "bounced",
			forever: true,
		});
		expect(said(bounced(permanent("550 5.1.10 Null MX")))).toEqual({
			reason: "bounced",
			forever: true,
		});
		expect(said(bounced(permanent("552 5.2.2 Mailbox full")))).toEqual({
			reason: "bounced",
			forever: false,
		});
		// A code about the sender, or none at the reply's start, isn't for good.
		expect(said(bounced(permanent("550 5.1.8 Sender rejected")))?.forever).toBe(false);
		expect(said(bounced(permanent("Rejected: 5.1.1 somewhere")))?.forever).toBe(false);
		expect(said(bounced({ ...permanent("421 4.7.0 Later"), type: "Transient" }))).toBeNull();
		expect(said(bounced({ ...permanent("550 5.1.1 Unknown"), type: "Undetermined" }))).toBeNull();
		expect(said(bounced({ ...permanent("550 5.1.1 Listed"), subType: "Suppressed" }))).toEqual({
			reason: "rejected",
			forever: false,
		});
		expect(said(event("email.suppressed"))).toEqual({ reason: "rejected", forever: false });
		for (const type of ["email.delivered", "email.delivery_delayed", "email.failed"]) {
			expect(said(event(type))).toBeNull();
		}
	});
});

function directory(fails?: Error) {
	const came: { domains: string[]; workspaceId: string | undefined }[] = [];
	const suppressed: NewSuppression[] = [];
	const known = new Map<string, Sender>([
		["help@example.com", { mailboxId: "box-help", workspaceId: "ws-help" }],
		["sales@example.net", { mailboxId: "box-sales", workspaceId: "ws-sales" }],
	]);
	const found: EventDirectory = {
		async eventsCame(domains, _at, { provider, workspaceId }) {
			if (fails) throw fails;
			expect(provider).toBe("resend");
			came.push({ domains, workspaceId });
		},
		async mailboxesOf(senders) {
			return new Map(
				[...senders].flatMap((one) => {
					const sender = known.get(one);
					return sender ? [[one, sender] as const] : [];
				}),
			);
		},
		async suppress(entries) {
			suppressed.push(...entries);
		},
	};
	return { ...found, came, suppressed };
}

/** A mailbox that has the messages it is told of, and notes what it recorded. */
function mailboxes(has = true, fails?: Error) {
	const recorded: { mailboxId: string; events: DeliveryEvent[] }[] = [];
	const mailbox = (mailboxId: string) => ({
		recordDeliveries(events: DeliveryEvent[]) {
			if (fails) throw fails;
			recorded.push({ mailboxId, events });
			return events.map(() => has);
		},
	});
	return { mailbox, recorded };
}

const read = (body: unknown) => {
	const one = readResendEvent(body, 0);
	if (!one) throw new Error("expected an event");
	return one;
};

describe("recording a Resend event", () => {
	it("records it in the workspace's mailbox, and adds the recipient to its list", async () => {
		const known = directory();
		const { mailbox, recorded } = mailboxes();
		const done = await recordResendEvent(
			read(bounced(permanent("550 5.1.1 User unknown"))),
			"ws-help",
			known,
			mailbox,
			at,
		);
		expect(done).toEqual({ status: 200, outcome: "recorded", suppressed: 1 });
		expect(recorded.map(({ mailboxId }) => mailboxId)).toEqual(["box-help"]);
		expect(known.came).toEqual([{ domains: ["example.com"], workspaceId: "ws-help" }]);
		expect(known.suppressed).toEqual([
			{
				workspaceId: "ws-help",
				address: "ada@example.org",
				reason: "bounced",
				provider: "resend",
				detail: "550 5.1.1 User unknown",
				at,
				expiresAt: null,
			},
		]);
		const kept = await recordResendEvent(
			read(event("email.suppressed")),
			"ws-help",
			known,
			mailbox,
			at,
		);
		expect(kept).toEqual({ status: 200, outcome: "recorded", suppressed: 1 });
		expect(known.suppressed[1]?.expiresAt).toBe(at + SUPPRESSION_DAYS * 24 * 60 * 60 * 1000);
	});

	it("leaves alone mail another workspace sent, or an address that isn't a mailbox's", async () => {
		const known = directory();
		const { mailbox, recorded } = mailboxes();
		const theirs = read(event("email.complained", { from: "sales@example.net" }));
		expect(await recordResendEvent(theirs, "ws-help", known, mailbox, at)).toEqual({
			status: 200,
			outcome: "notOurs",
			suppressed: 0,
		});
		const nobody = read(event("email.complained", { from: "nobody@example.com" }));
		expect((await recordResendEvent(nobody, "ws-help", known, mailbox, at)).outcome).toBe(
			"notOurs",
		);
		expect(recorded).toEqual([]);
		expect(known.suppressed).toEqual([]);
		expect(known.came).toEqual([]);
	});

	it("asks for a message not found yet again, then lets it go, listing nothing for it", async () => {
		const known = directory();
		const { mailbox } = mailboxes(false);
		const complaint = read(event("email.complained"));
		expect(await recordResendEvent(complaint, "ws-help", known, mailbox, at + 1_000)).toEqual({
			status: 503,
			outcome: "waiting",
			suppressed: 0,
		});
		expect(
			await recordResendEvent(complaint, "ws-help", known, mailbox, at + FIND_WINDOW_MS + 1),
		).toEqual({ status: 200, outcome: "notFound", suppressed: 0 });
		expect(known.suppressed).toEqual([]);
		// Resend gave the message an id before leaving the address out, so its list counts only for a
		// message the mailbox has, as everything else does.
		const kept = read(event("email.suppressed"));
		const late = await recordResendEvent(kept, "ws-help", known, mailbox, at + FIND_WINDOW_MS + 1);
		expect(late).toEqual({ status: 200, outcome: "notFound", suppressed: 0 });
		expect(known.suppressed).toEqual([]);
	});

	it("has it come again when D1 or the mailbox fails, naming no address", async () => {
		const complaint = read(event("email.complained"));
		const down = await recordResendEvent(
			complaint,
			"ws-help",
			directory(new Error("D1 is down for ada@example.org")),
			mailboxes().mailbox,
			at,
		);
		expect(down).toMatchObject({ status: 503, outcome: "failed" });
		expect(JSON.stringify(down)).not.toContain("ada@");
		const known = directory();
		const broken = await recordResendEvent(
			complaint,
			"ws-help",
			known,
			mailboxes(true, new Error("the object restarted")).mailbox,
			at,
		);
		expect(broken).toMatchObject({ status: 503, outcome: "failed" });
		expect(known.suppressed).toEqual([]);

		const listing = directory();
		listing.suppress = async () => {
			throw new Error("D1 is down for ada@example.org");
		};
		const unlisted = await recordResendEvent(
			complaint,
			"ws-help",
			listing,
			mailboxes().mailbox,
			at,
		);
		expect(unlisted).toMatchObject({ status: 503, outcome: "failed" });
		expect(unlisted.status === 503 && unlisted.outcome === "failed" && unlisted.failure).toMatch(
			/^suppressions/,
		);
		expect(JSON.stringify(unlisted)).not.toContain("ada@");
	});
});
