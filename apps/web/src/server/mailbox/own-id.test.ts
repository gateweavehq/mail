import { describe, expect, it } from "vitest";
import { isOwnId, newOwnId } from "./own-id";

const SECRET = "a deployment's BETTER_AUTH_SECRET, long and random";
const MAILBOX = "5f0c8a52-3d1e-4b7a-9c2f-1e6d8b4a7c30";

describe("Mail's own message ids", () => {
	it("are new each time, on the domain the message is sent from", async () => {
		const id = await newOwnId(SECRET, MAILBOX, "support@acme.test");
		expect(id).toMatch(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{22}@acme\.test$/);
		expect(await newOwnId(SECRET, MAILBOX, "support@acme.test")).not.toBe(id);
	});

	it("check for the mailbox that sent them, with or without angle brackets", async () => {
		const id = await newOwnId(SECRET, MAILBOX, "support@acme.test");
		expect(await isOwnId(SECRET, MAILBOX, id)).toBe(true);
		expect(await isOwnId(SECRET, MAILBOX, `<${id}>`)).toBe(true);
		// A domain's case is no part of it.
		expect(await isOwnId(SECRET, MAILBOX, id.replace("acme.test", "ACME.test"))).toBe(true);
	});

	it("don't check for another mailbox, or under another deployment's secret", async () => {
		const id = await newOwnId(SECRET, MAILBOX, "support@acme.test");
		expect(await isOwnId(SECRET, "another-mailbox", id)).toBe(false);
		expect(await isOwnId("another deployment's secret", MAILBOX, id)).toBe(false);
		// And back to the first, as one isolate's key follows the secret it is given.
		expect(await isOwnId(SECRET, MAILBOX, id)).toBe(true);
	});

	it("aren't made without a secret", async () => {
		await expect(newOwnId("", MAILBOX, "support@acme.test")).rejects.toThrow(/BETTER_AUTH_SECRET/);
	});

	it("don't check once changed: another id, signature or domain, or one cut short", async () => {
		const id = await newOwnId(SECRET, MAILBOX, "support@acme.test");
		const [uuid = "", rest = ""] = id.split(".", 2);
		const [signature = ""] = rest.split("@");
		const otherUuid = `${uuid.slice(0, -1)}${uuid.endsWith("0") ? "1" : "0"}`;
		// The first character, as the last one's low bits are padding that decodes to nothing.
		const flipped = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
		for (const changed of [
			`${otherUuid}.${signature}@acme.test`,
			`${uuid}.${flipped}@acme.test`,
			`${uuid}.${signature}@other.test`,
			`${uuid}.${signature.slice(0, 21)}@acme.test`,
			`${uuid}@acme.test`,
			"",
		]) {
			expect(await isOwnId(SECRET, MAILBOX, changed)).toBe(false);
		}
	});

	it("aren't ids Mail gave before they were signed", async () => {
		expect(await isOwnId(SECRET, MAILBOX, `${crypto.randomUUID()}@acme.test`)).toBe(false);
	});
});
