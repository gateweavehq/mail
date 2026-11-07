import { inspect } from "node:util";
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
		).rejects.toThrow();
		expect(reasons).toEqual([]);
	});

	// A failed query's message quotes its parameters, and Workers Logs keeps what this throws.
	it("lets no word of a failed lookup's error out, since it can hold the address", async () => {
		const { message } = incoming("private@example.org");
		const logged: unknown[][] = [];
		const realError = console.error;
		console.error = (...args: unknown[]) => logged.push(args);
		try {
			const thrown = await receiveMail(message, async (recipient) => {
				throw new Error(`Failed query, params: ${recipient}`);
			}).catch((error: Error) => error);
			expect(thrown).toBeInstanceOf(Error);
			// `inspect`, not JSON, since JSON leaves out an error's message and cause.
			expect(inspect(thrown, { depth: null })).not.toContain("private");
		} finally {
			console.error = realError;
		}
		expect(logged).toHaveLength(1);
		expect(inspect(logged, { depth: null })).not.toContain("private");
	});
});
