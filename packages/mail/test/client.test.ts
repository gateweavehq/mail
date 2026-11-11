import { readFileSync } from "node:fs";
import { inspect } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { MailClient, MailError, ROUTES } from "../src/index.js";

const KEY = "gwm_ws.abcdefghijklmnopqrstuvwxyz0123456789";

interface Asked {
	url: URL;
	method: string;
	headers: Headers;
	body: string | undefined;
	signal: AbortSignal | undefined;
}

/** A client whose fetch answers with these, in turn, and keeps what it was asked. */
function clientWith(...answers: (() => Response)[]) {
	const asked: Asked[] = [];
	const client = new MailClient({
		url: "https://mail.example.com/",
		key: KEY,
		async fetch(url, init) {
			asked.push({
				url: new URL(url),
				method: init.method ?? "GET",
				headers: new Headers(init.headers),
				body: typeof init.body === "string" ? init.body : undefined,
				signal: init.signal ?? undefined,
			});
			const answer = answers.shift() ?? (() => Response.json({ ok: true }));
			return answer();
		},
	});
	return { client, asked };
}

const json =
	(body: unknown, status = 200, headers: Record<string, string> = {}) =>
	() =>
		Response.json(body, { status, headers });

/** What a call threw. */
async function thrown(promise: Promise<unknown>): Promise<unknown> {
	try {
		await promise;
	} catch (error) {
		return error;
	}
	throw new Error("expected it to throw");
}

describe("MailClient", () => {
	it("has a method for every route, named for its operationId in camelCase", () => {
		const { client } = clientWith();
		const names = Object.keys(ROUTES).map((id) =>
			id.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase()),
		);
		expect(names).toEqual([
			"listMailboxes",
			"searchEmail",
			"readEmail",
			"readThread",
			"getAttachment",
			"waitForEmail",
			"getVerificationCode",
			"sendEmail",
			"reply",
			"listAddresses",
			"createAddress",
			"endAddress",
			"listWebhooks",
			"createWebhook",
			"updateWebhook",
			"deleteWebhook",
			"testWebhook",
		]);
		for (const name of names) {
			expect(typeof (client as unknown as Record<string, unknown>)[name], name).toBe("function");
		}
		// And the methods its type promises are the ones it has.
		const declared = readFileSync(new URL("../src/api.gen.ts", import.meta.url), "utf8")
			.split("export interface MailMethods {")[1]
			?.matchAll(/^\t(\w+)\(input/gm);
		expect([...(declared ?? [])].map((match) => match[1])).toEqual(names);
	});

	it("asks the route under /api/v1 with the key as a bearer token, and gives its answer", async () => {
		const answer = { mailboxes: [], sending: { perDay: 5, withoutApproval: [] } };
		const { client, asked } = clientWith(json(answer));
		expect(await client.listMailboxes()).toEqual(answer);
		const [one] = asked;
		expect(one?.method).toBe("GET");
		expect(one?.url.href).toBe("https://mail.example.com/api/v1/mailboxes");
		expect(one?.headers.get("authorization")).toBe(`Bearer ${KEY}`);
		expect(one?.headers.get("accept")).toBe("application/json");
		expect(one?.headers.get("content-type")).toBeNull();
		expect(one?.body).toBeUndefined();
		expect(client.url).toBe("https://mail.example.com");
	});

	it("puts path inputs in the path, encoded, and only a route's own query inputs in its query", async () => {
		const { client, asked } = clientWith();
		await client.readEmail({ mailbox: "Sign-ups/2 & co", messageId: "a b?" });
		await client.getAttachment({ mailbox: "box", messageId: "m1", index: 0 });
		await client.searchEmail({ mailbox: "box", query: "your code", cursor: undefined });
		const extra = { mailbox: "box", threadId: "t1", messageId: "ignored" };
		await client.readThread(extra as Parameters<typeof client.readThread>[0]);
		const [read, file, search, thread] = asked;
		expect(read?.url.pathname).toBe("/api/v1/mailboxes/Sign-ups%2F2%20%26%20co/messages/a%20b%3F");
		expect(read?.url.search).toBe("");
		expect(file?.url.pathname).toBe("/api/v1/mailboxes/box/messages/m1/attachments/0");
		expect(search?.url.pathname).toBe("/api/v1/mailboxes/box/threads");
		expect([...(search?.url.searchParams ?? [])]).toEqual([["query", "your code"]]);
		expect(thread?.url.pathname).toBe("/api/v1/mailboxes/box/threads/t1");
		expect(thread?.url.search).toBe("");
	});

	it("writes a wait's numbers and booleans in its query as the API reads them", async () => {
		const { client, asked } = clientWith(json({ found: false }));
		const since = "2026-11-11T09:59:00.000Z";
		expect(
			await client.getVerificationCode({
				to: "signups@acme.example",
				from: "github.com",
				provedOnly: false,
				since,
				timeoutSeconds: 20,
			}),
		).toEqual({ found: false });
		expect(Object.fromEntries(asked[0]?.url.searchParams ?? [])).toEqual({
			to: "signups@acme.example",
			from: "github.com",
			provedOnly: "false",
			since,
			timeoutSeconds: "20",
		});
	});

	it("sends a POST's or PATCH's inputs, but its path's, as a JSON body", async () => {
		const { client, asked } = clientWith(json({ id: "m1", threadId: "t1", state: "held" }));
		const sent = await client.sendEmail({
			mailbox: "Sign-ups",
			to: ["someone@example.org"],
			subject: "Hello",
			text: "Hi.",
			html: undefined,
		});
		expect(sent.state).toBe("held");
		await client.updateWebhook({ webhookId: "w1", active: false });
		await client.testWebhook({ webhookId: "w1" });
		await client.endAddress({ mailbox: "Sign-ups", addressId: "a1" });
		const [send, update, test, end] = asked;
		expect(send?.method).toBe("POST");
		expect(send?.url.pathname).toBe("/api/v1/mailboxes/Sign-ups/messages");
		expect(send?.headers.get("content-type")).toBe("application/json");
		expect(JSON.parse(send?.body ?? "")).toEqual({
			to: ["someone@example.org"],
			subject: "Hello",
			text: "Hi.",
		});
		expect(update?.method).toBe("PATCH");
		expect(update?.url.pathname).toBe("/api/v1/webhooks/w1");
		expect(JSON.parse(update?.body ?? "")).toEqual({ active: false });
		expect(test?.url.pathname).toBe("/api/v1/webhooks/w1/test");
		expect(test?.body).toBe("{}");
		expect(end?.method).toBe("DELETE");
		expect(end?.url.pathname).toBe("/api/v1/mailboxes/Sign-ups/addresses/a1");
		expect(end?.body).toBeUndefined();
	});

	it("calls a route by its operationId, and passes on a signal", async () => {
		const { client, asked } = clientWith(json({ webhooks: [], max: 3 }));
		const signal = new AbortController().signal;
		expect(await client.call("list_webhooks", {}, { signal })).toEqual({ webhooks: [], max: 3 });
		expect(asked[0]?.signal).toBe(signal);
		await expect(client.call("no_such" as "list_webhooks")).rejects.toThrow(TypeError);
	});

	it("refuses to call a route without what its path needs", async () => {
		const { client, asked } = clientWith();
		const missing = { mailbox: "box" } as Parameters<typeof client.readEmail>[0];
		await expect(client.readEmail(missing)).rejects.toThrow(/readEmail takes messageId/);
		expect(asked).toEqual([]);
	});

	it("throws a MailError with Mail's words, its status and what was wrong", async () => {
		const { client } = clientWith(
			json(
				{
					error: "The request isn't one this route takes.",
					issues: [{ path: "from", message: "Invalid input" }, { nonsense: true }],
				},
				400,
			),
			json({ error: "Mail's agent API takes an agent's key." }, 401),
			json({ error: "You may read this mailbox but not send from it." }, 403),
			json({ error: 'No mailbox "Billing" that you may read. See list_mailboxes.' }, 404),
			json({ error: "The message names nobody to answer." }, 409),
			json({ error: "Mail couldn't do that just now. Try again." }, 500),
		);
		const wait = { to: "a@acme.example", from: "" };
		const refused = await thrown(client.getVerificationCode(wait));
		expect(refused).toBeInstanceOf(MailError);
		expect(refused).toMatchObject({
			name: "MailError",
			status: 400,
			operation: "get_verification_code",
			message: "The request isn't one this route takes.",
			issues: [{ path: "from", message: "Invalid input" }],
			retryAfter: null,
		});
		for (const status of [401, 403, 404, 409, 500]) {
			const error = await thrown(client.listMailboxes());
			expect(error).toBeInstanceOf(MailError);
			expect((error as MailError).status).toBe(status);
			expect((error as MailError).issues).toEqual([]);
		}
	});

	it("says in how many seconds to try again after a 429, as a number or a date", async () => {
		const { client } = clientWith(
			json({ error: "You have waited for mail many times." }, 429, { "retry-after": "42" }),
			json({ error: "Too many." }, 429, {
				"retry-after": new Date(Date.now() + 90_000).toUTCString(),
			}),
			json({ error: "Too many." }, 429),
		);
		expect(await thrown(client.waitForEmail({ to: "a@acme.example" }))).toMatchObject({
			status: 429,
			retryAfter: 42,
		});
		const dated = (await thrown(client.listMailboxes())) as MailError;
		expect(dated.retryAfter).toBeGreaterThanOrEqual(88);
		expect(dated.retryAfter).toBeLessThanOrEqual(90);
		expect(await thrown(client.listMailboxes())).toMatchObject({ status: 429, retryAfter: null });
	});

	it("throws a MailError for an answer that isn't Mail's JSON", async () => {
		const { client } = clientWith(
			() => new Response("<h1>Bad gateway</h1>", { status: 502, statusText: "Bad Gateway" }),
			() => new Response("not json", { status: 200 }),
			() => Response.json([1, 2], { status: 200 }),
		);
		expect(await thrown(client.listMailboxes())).toMatchObject({
			status: 502,
			message: "Mail answered 502 Bad Gateway.",
		});
		expect(await thrown(client.listMailboxes())).toMatchObject({
			status: 200,
			message: expect.stringMatching(/isn't the JSON object/),
		});
		expect(await thrown(client.listMailboxes())).toBeInstanceOf(MailError);
	});

	it("never lets the key into an error, or show it", async () => {
		// As a proxy might repeat what it was sent.
		const { client } = clientWith(
			json(
				{ error: `Bad token Bearer ${KEY}`, issues: [{ path: KEY, message: `not ${KEY}` }] },
				401,
			),
		);
		const error = await thrown(client.listMailboxes());
		for (const shown of [
			String(error),
			(error as Error).stack ?? "",
			JSON.stringify(error),
			inspect(error, { depth: 5 }),
			inspect(client, { depth: 5, showHidden: true }),
			JSON.stringify(client),
		]) {
			expect(shown).not.toContain(KEY);
		}
		expect((error as MailError).message).toBe("Bad token Bearer [key]");
		const noUrl = await thrown(
			Promise.resolve().then(() => new MailClient({ url: "mail", key: KEY })),
		);
		expect(noUrl).toBeInstanceOf(TypeError);
		expect(String(noUrl)).not.toContain(KEY);
		expect(() => new MailClient({ url: "https://mail.example.com", key: "" })).toThrow(TypeError);
	});

	it("uses the global fetch unless given one", async () => {
		const global = vi.fn(async () => Response.json({ addresses: [], live: 0 }));
		vi.stubGlobal("fetch", global);
		try {
			const client = new MailClient({ url: "https://mail.example.com", key: KEY });
			expect(await client.listAddresses({ mailbox: "box" })).toEqual({ addresses: [], live: 0 });
			expect(global).toHaveBeenCalledWith(
				"https://mail.example.com/api/v1/mailboxes/box/addresses",
				expect.objectContaining({ method: "GET" }),
			);
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
