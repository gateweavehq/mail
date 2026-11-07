import { describe, expect, it, vi } from "vitest";
import { createMailer, parseSender } from "./mailer";

describe("parseSender", () => {
	it("reads a named or a bare address", () => {
		expect(parseSender("Gateweave Mail <mail@example.com>")).toEqual({
			name: "Gateweave Mail",
			email: "mail@example.com",
		});
		expect(parseSender('"Mail, by Gateweave" <mail@example.com>')).toEqual({
			name: "Mail, by Gateweave",
			email: "mail@example.com",
		});
		expect(parseSender(" mail@example.com ")).toBe("mail@example.com");
		expect(parseSender("<mail@example.com>")).toBe("mail@example.com");
	});

	it("rejects anything that is not an address", () => {
		expect(parseSender("Gateweave Mail")).toBeUndefined();
		expect(parseSender("Mail <not an address>")).toBeUndefined();
		expect(parseSender("")).toBeUndefined();
	});
});

describe("createMailer", () => {
	const email = { to: "maya@example.com", subject: "Hi", text: "Hello", html: "<p>Hello</p>" };

	it("sends from the configured sender", async () => {
		const send = vi.fn(async () => ({ messageId: "1" }));
		const mailer = createMailer({ send } as unknown as SendEmail, "Mail <mail@example.com>");
		await mailer?.send(email);
		expect(send).toHaveBeenCalledWith({
			from: { name: "Mail", email: "mail@example.com" },
			...email,
		});
	});

	it("logs why a send failed, without the address, and still fails", async () => {
		const failure = Object.assign(new Error("maya@example.com is suppressed"), {
			code: "E_RECIPIENT_SUPPRESSED",
		});
		const send = vi.fn(async () => {
			throw failure;
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const mailer = createMailer({ send } as unknown as SendEmail, "mail@example.com");

		await expect(mailer?.send(email)).rejects.toBe(failure);

		expect(logged).toHaveBeenCalledWith("email: a message was not sent", {
			code: "E_RECIPIENT_SUPPRESSED",
		});
		expect(JSON.stringify(logged.mock.calls)).not.toContain("maya@");
		logged.mockRestore();
	});

	it("logs a failure with no code as unknown", async () => {
		const send = vi.fn(async () => {
			throw new Error("Something else");
		});
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const mailer = createMailer({ send } as unknown as SendEmail, "mail@example.com");

		await expect(mailer?.send(email)).rejects.toThrow("Something else");

		expect(logged).toHaveBeenCalledWith("email: a message was not sent", { code: "unknown" });
		logged.mockRestore();
	});

	it("is off without a binding or a valid sender", () => {
		const binding = { send: vi.fn() } as unknown as SendEmail;
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(createMailer(undefined, "mail@example.com")).toBeUndefined();
		expect(createMailer(binding, undefined)).toBeUndefined();
		expect(createMailer(binding, "not an address")).toBeUndefined();
	});
});
