import { describe, expect, it } from "vitest";
import { NO_SUCH_ADDRESS, receiveMail } from "./inbound";

function incoming(to = "someone@example.org") {
	const reasons: string[] = [];
	return { reasons, message: { to, setReject: (reason: string) => reasons.push(reason) } };
}

describe("receiveMail", () => {
	it("refuses for good a message to an address that doesn't exist", async () => {
		const { message, reasons } = incoming();
		await receiveMail(message, async () => null);
		expect(reasons).toEqual([NO_SUCH_ADDRESS]);
		expect(NO_SUCH_ADDRESS).toBe("No such address");
	});

	it("asks about the address the message came to", async () => {
		const { message } = incoming("help@example.org");
		const asked: string[] = [];
		await receiveMail(message, async (recipient) => {
			asked.push(recipient);
			return null;
		});
		expect(asked).toEqual(["help@example.org"]);
	});

	// A throw makes the sender try again. A refusal would tell them the address is gone, and
	// returning normally would tell them we kept a message we didn't.
	it("makes the sender try again for an address that exists, since mail can't be stored yet", async () => {
		const { message, reasons } = incoming();
		await expect(receiveMail(message, async () => ({ mailboxId: "box" }))).rejects.toThrow();
		expect(reasons).toEqual([]);
	});

	it("makes the sender try again when the lookup fails, and doesn't refuse them", async () => {
		const { message, reasons } = incoming();
		await expect(
			receiveMail(message, async () => {
				throw new Error("D1 is unavailable");
			}),
		).rejects.toThrow("D1 is unavailable");
		expect(reasons).toEqual([]);
	});
});
