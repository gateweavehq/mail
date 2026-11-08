import { inspect } from "node:util";
import { describe, expect, it } from "vitest";
import { NO_SUCH_ADDRESS, receiveMail } from "./inbound";

function incoming(to = "someone@example.org") {
	const reasons: string[] = [];
	return { reasons, message: { to, setReject: (reason: string) => reasons.push(reason) } };
}

/** For cases that must never reach storing. */
async function refuseToStore(): Promise<void> {
	throw new Error("This message should not have been stored");
}

describe("receiveMail", () => {
	it("refuses for good a message to an address that doesn't exist", async () => {
		const { message, reasons } = incoming();
		await receiveMail(message, async () => null, refuseToStore);
		expect(reasons).toEqual([NO_SUCH_ADDRESS]);
		expect(NO_SUCH_ADDRESS).toBe("No such address");
	});

	it("asks about the address the message came to", async () => {
		const { message } = incoming("help@example.org");
		const asked: string[] = [];
		await receiveMail(
			message,
			async (recipient) => {
				asked.push(recipient);
				return null;
			},
			refuseToStore,
		);
		expect(asked).toEqual(["help@example.org"]);
	});

	it("stores a message to an address that exists, in the mailbox the directory found", async () => {
		const { message, reasons } = incoming();
		const stored: unknown[] = [];
		await receiveMail(
			message,
			async () => ({ mailboxId: "box" }),
			async (found) => {
				stored.push(found);
			},
		);
		expect(stored).toEqual([{ mailboxId: "box" }]);
		expect(reasons).toEqual([]);
	});

	// A throw makes the sender try again. A refusal would tell them the address is gone, and
	// returning normally would tell them we kept a message we didn't.
	it("makes the sender try again when storing fails, and doesn't refuse them", async () => {
		const { message, reasons } = incoming();
		await expect(
			receiveMail(message, async () => ({ mailboxId: "box" }), refuseToStore),
		).rejects.toThrow();
		expect(reasons).toEqual([]);
	});

	it("lets no word of a failed write's error out", async () => {
		const { message } = incoming("private@example.org");
		const logged: unknown[][] = [];
		const realError = console.error;
		console.error = (...args: unknown[]) => logged.push(args);
		try {
			const thrown = await receiveMail(
				message,
				async () => ({ mailboxId: "box" }),
				async () => {
					throw new Error("Failed write for private@example.org");
				},
			).catch((error: Error) => error);
			expect(thrown).toBeInstanceOf(Error);
			expect(inspect(thrown, { depth: null })).not.toContain("private");
		} finally {
			console.error = realError;
		}
		expect(logged).toHaveLength(1);
		expect(inspect(logged, { depth: null })).not.toContain("private");
	});

	it("makes the sender try again when the lookup fails, and doesn't refuse them", async () => {
		const { message, reasons } = incoming();
		await expect(
			receiveMail(
				message,
				async () => {
					throw new Error("D1 is unavailable");
				},
				refuseToStore,
			),
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
			const thrown = await receiveMail(
				message,
				async (recipient) => {
					throw new Error(`Failed query, params: ${recipient}`);
				},
				refuseToStore,
			).catch((error: Error) => error);
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
