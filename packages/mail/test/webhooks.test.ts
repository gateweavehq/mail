import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyWebhook, WebhookError } from "../src/index.js";

// The example in Svix's documentation of the scheme, which Standard Webhooks took on, and which
// apps/web/src/server/webhooks/signing.test.ts signs with too.
const VECTOR = {
	secret: "whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
	id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
	timestamp: 1614265330,
	body: '{"test": 2432232314}',
	signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
};
const AT = VECTOR.timestamp * 1000;

const headers = (signature = VECTOR.signature, timestamp = VECTOR.timestamp) => ({
	"webhook-id": VECTOR.id,
	"webhook-timestamp": String(timestamp),
	"webhook-signature": signature,
});

/** A delivery as Mail signs one, with a secret of its own. */
function delivery(body: string, timestamp = Math.floor(Date.now() / 1000)) {
	const secret = `whsec_${randomBytes(24).toString("base64")}`;
	const id = `dlv_${randomBytes(8).toString("hex")}`;
	const mac = createHmac("sha256", Buffer.from(secret.slice("whsec_".length), "base64"))
		.update(`${id}.${timestamp}.${body}`)
		.digest("base64");
	return {
		secret,
		headers: new Headers({
			"webhook-id": id,
			"webhook-timestamp": String(timestamp),
			"webhook-signature": `v1,${mac}`,
		}),
		body,
	};
}

async function refusal(promise: Promise<unknown>): Promise<string> {
	try {
		await promise;
	} catch (error) {
		expect(error).toBeInstanceOf(WebhookError);
		return (error as Error).message;
	}
	throw new Error("expected a WebhookError");
}

describe("verifyWebhook", () => {
	it("takes what Standard Webhooks libraries take, and gives the body", async () => {
		const event = await verifyWebhook({
			secret: VECTOR.secret,
			headers: headers(),
			body: VECTOR.body,
			now: AT,
		});
		expect(event).toEqual({ test: 2432232314 });
	});

	it("gives a delivery's event, from headers as fetch or Node has them, and its body as bytes", async () => {
		const body = JSON.stringify({
			type: "message.received",
			timestamp: "2026-11-11T10:00:00.000Z",
			data: { mailbox: { id: "mb1", name: "Sign-ups" } },
		});
		const signed = delivery(body);
		expect(await verifyWebhook(signed)).toMatchObject({
			type: "message.received",
			data: { mailbox: { name: "Sign-ups" } },
		});
		const node = Object.fromEntries(
			[...signed.headers].map(([name, value]) => [name.replace(/^w/, "W"), value]),
		);
		const bytes = new TextEncoder().encode(body);
		expect((await verifyWebhook({ ...signed, headers: node, body: bytes })).type).toBe(
			"message.received",
		);
		expect((await verifyWebhook({ ...signed, body: bytes.buffer })).type).toBe("message.received");
	});

	it("refuses a body changed since it was signed", async () => {
		const tampered = VECTOR.body.replace("2432232314", "2432232315");
		expect(
			await refusal(
				verifyWebhook({ secret: VECTOR.secret, headers: headers(), body: tampered, now: AT }),
			),
		).toMatch(/doesn't match/);
		// The id and the time are signed too.
		const moved = { ...headers(), "webhook-id": "msg_other" };
		expect(
			await refusal(
				verifyWebhook({ secret: VECTOR.secret, headers: moved, body: VECTOR.body, now: AT }),
			),
		).toMatch(/doesn't match/);
	});

	it("refuses a signature another secret made", async () => {
		const other = `whsec_${randomBytes(24).toString("base64")}`;
		expect(
			await refusal(
				verifyWebhook({ secret: other, headers: headers(), body: VECTOR.body, now: AT }),
			),
		).toMatch(/another secret/);
	});

	it("refuses a delivery signed longer ago, or further ahead, than the tolerance", async () => {
		const check = (now: number, toleranceSeconds?: number) =>
			verifyWebhook({
				secret: VECTOR.secret,
				headers: headers(),
				body: VECTOR.body,
				now,
				toleranceSeconds,
			});
		expect(await check(AT + 300_000)).toEqual({ test: 2432232314 });
		expect(await refusal(check(AT + 301_000))).toMatch(/signed 301 seconds ago, more than the 300/);
		expect(await refusal(check(AT - 301_000))).toMatch(/301 seconds from now/);
		expect(await refusal(check(AT + 61_000, 60))).toMatch(/more than the 60/);
		expect(await check(AT + 3_600_000, 7200)).toEqual({ test: 2432232314 });
		// A Date does as well as milliseconds.
		const late = verifyWebhook({
			secret: VECTOR.secret,
			headers: headers(),
			body: VECTOR.body,
			now: new Date(AT + 600_000),
		});
		expect(await refusal(late)).toMatch(/600 seconds ago/);
	});

	it("takes any one of several signatures, as while a secret changes, and only v1", async () => {
		const wrong = "v1,AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
		const check = (signature: string) =>
			verifyWebhook({
				secret: VECTOR.secret,
				headers: headers(signature),
				body: VECTOR.body,
				now: AT,
			});
		expect(await check(`${wrong} ${VECTOR.signature}`)).toEqual({ test: 2432232314 });
		expect(await check(`v2,whatever ${VECTOR.signature} ${wrong}`)).toEqual({ test: 2432232314 });
		expect(await refusal(check(`${wrong} v1,not-base64!`))).toMatch(/doesn't match/);
		expect(await refusal(check(`v2,${VECTOR.signature.slice(3)}`))).toMatch(/no v1 signature/);
	});

	it("refuses a delivery without its headers, or with a time that isn't one", async () => {
		const { "webhook-signature": _, ...unsigned } = headers();
		expect(
			await refusal(verifyWebhook({ secret: VECTOR.secret, headers: unsigned, body: VECTOR.body })),
		).toMatch(/no webhook-id, webhook-timestamp or webhook-signature/);
		const soon = { ...headers(), "webhook-timestamp": "soon" };
		expect(
			await refusal(verifyWebhook({ secret: VECTOR.secret, headers: soon, body: VECTOR.body })),
		).toMatch(/isn't a time/);
	});

	it("refuses a signed body that isn't a JSON object", async () => {
		const signed = delivery("not json");
		expect(await refusal(verifyWebhook(signed))).toMatch(/isn't a JSON object/);
	});

	it("throws a TypeError for a secret that isn't one", async () => {
		for (const secret of ["", "MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", "whsec_", "whsec_not base64!"]) {
			await expect(
				verifyWebhook({ secret, headers: headers(), body: VECTOR.body, now: AT }),
			).rejects.toThrow(TypeError);
		}
	});
});
