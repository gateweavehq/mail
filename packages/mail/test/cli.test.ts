import { createHmac, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type CliIO, run } from "../src/run.js";

const KEY = "gwm_ws.abcdefghijklmnopqrstuvwxyz0123456789";
const URL_ = "https://mail.example.com";
const ENV = { GATEWEAVE_MAIL_URL: URL_, GATEWEAVE_MAIL_KEY: KEY };
const document = JSON.parse(readFileSync(new URL("../openapi.json", import.meta.url), "utf8"));
/** The longest one wait the API takes, as its document says. */
const MAX_WAIT: number = document.paths["/verification-code"].get.parameters.find(
	(one: { name: string }) => one.name === "timeoutSeconds",
).schema.maximum;

interface Asked {
	method: string;
	path: string;
	query: Record<string, string>;
	body: unknown;
	authorization: string | null;
}

type Answer = (asked: Asked) => Response;

/**
 * Runs the command with a fake Mail, which answers each request with the next of `answers`, and a
 * clock of its own: a wait takes as long as it asked, a pause as long as it says, and no longer.
 */
async function cli(
	args: string[],
	{
		answers = [],
		env = ENV,
		stdin = "",
		files = {},
		tty = false,
	}: {
		answers?: Answer[];
		env?: Record<string, string | undefined>;
		stdin?: string;
		files?: Record<string, string>;
		tty?: boolean;
	} = {},
) {
	let clock = Date.parse("2026-11-11T10:00:00.000Z");
	const asked: Asked[] = [];
	const slept: number[] = [];
	let stdout = "";
	let stderr = "";
	const io: CliIO = {
		env,
		stdin: async () => new TextEncoder().encode(stdin),
		stdinIsTTY: tty,
		stdout: (text) => {
			stdout += text;
		},
		stderr: (text) => {
			stderr += text;
		},
		async readFile(path) {
			const file = files[path];
			if (file === undefined) throw new Error(`ENOENT: no such file, open '${path}'`);
			return new TextEncoder().encode(file);
		},
		async fetch(url, init) {
			const at = new URL(url);
			const one: Asked = {
				method: init.method ?? "GET",
				path: at.pathname,
				query: Object.fromEntries(at.searchParams),
				body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
				authorization: new Headers(init.headers).get("authorization"),
			};
			asked.push(one);
			const answer = answers.shift();
			if (!answer) throw new Error(`nothing to answer ${one.method} ${one.path}`);
			const response = answer(one);
			// A wait that found nothing took as long as it asked.
			if (one.query.timeoutSeconds && response.status === 200) {
				const body = (await response.clone().json()) as { found?: boolean };
				if (body.found === false) clock += Number(one.query.timeoutSeconds) * 1000;
			}
			return response;
		},
		now: () => clock,
		async sleep(ms) {
			slept.push(ms);
			clock += ms;
		},
	};
	const code = await run(args, io);
	expect(stdout + stderr).not.toContain(KEY);
	return { code, stdout, stderr, asked, slept };
}

const json =
	(body: unknown, status = 200, headers: Record<string, string> = {}): Answer =>
	() =>
		Response.json(body, { status, headers });
const notYet = json({ found: false });
const code = (found: string | null) =>
	json({
		found: true,
		code: found,
		messageId: "m1",
		fromDomain: "github.com",
		verifiedDomain: "github.com",
		dmarc: "pass",
		arrivedAt: "2026-11-11T10:01:00.000Z",
	});

describe("gateweave-mail code", () => {
	it("waits until a code comes, and prints only the code", async () => {
		const ran = await cli(["code", "--to", "signups@acme.example", "--from", "github.com"], {
			answers: [notYet, code("482913")],
		});
		expect(ran).toMatchObject({ code: 0, stdout: "482913\n", stderr: "" });
		expect(ran.asked).toHaveLength(2);
		const [first, second] = ran.asked;
		expect(first).toMatchObject({
			method: "GET",
			path: "/api/v1/verification-code",
			authorization: `Bearer ${KEY}`,
			query: {
				to: "signups@acme.example",
				from: "github.com",
				provedOnly: "true",
				// From when the command started, not the 5 minutes before that the API would take.
				since: "2026-11-11T10:00:00.000Z",
				timeoutSeconds: String(MAX_WAIT),
			},
		});
		expect(second?.query).toEqual(first?.query);
	});

	it("waits no longer than --timeout, asking for no more than the time left", async () => {
		const ran = await cli(["code", "--mailbox", "Sign-ups", "--from", "github.com"], {
			answers: [notYet, notYet, notYet],
		});
		expect(ran.code).toBe(1);
		expect(ran.stdout).toBe("");
		expect(ran.stderr).toMatch(/^No code from github.com came in 120 seconds\./);
		expect(ran.stderr).toMatch(/--since takes an earlier time/);
		expect(ran.asked.map((one) => Number(one.query.timeoutSeconds))).toEqual([
			MAX_WAIT,
			MAX_WAIT,
			120 - 2 * MAX_WAIT,
		]);

		const short = await cli(
			["code", "--to", "a@acme.example", "--from", "x.example", "--timeout", "0"],
			{
				answers: [notYet],
			},
		);
		expect(short.code).toBe(1);
		expect(short.asked.map((one) => one.query.timeoutSeconds)).toEqual(["0"]);
	});

	it("waits as long as a 429 says before waiting again, when the time allows", async () => {
		const limited = json({ error: "You have waited for mail many times." }, 429, {
			"retry-after": "30",
		});
		const ran = await cli(["code", "--to", "a@acme.example", "--from", "github.com"], {
			answers: [limited, code("123456")],
		});
		expect(ran).toMatchObject({ code: 0, stdout: "123456\n" });
		expect(ran.slept).toEqual([30_000]);
		expect(ran.stderr).toMatch(/wait 30 seconds/);
		expect(ran.asked).toHaveLength(2);

		const tooLong = json({ error: "You have waited for mail many times." }, 429, {
			"retry-after": "300",
		});
		const gaveUp = await cli(["code", "--to", "a@acme.example", "--from", "github.com"], {
			answers: [tooLong],
		});
		expect(gaveUp.code).toBe(1);
		expect(gaveUp.slept).toEqual([]);
		expect(gaveUp.stderr).toMatch(/^Mail answered 429 to get_verification_code: You have waited/);
		expect(gaveUp.stderr).toMatch(/Try again in 300 seconds\./);
	});

	it("says so when the message came without a code it could tell apart", async () => {
		const ran = await cli(["code", "--to", "a@acme.example", "--from", "github.com"], {
			answers: [code(null)],
		});
		expect(ran.code).toBe(1);
		expect(ran.stdout).toBe("");
		expect(ran.stderr).toContain("gateweave-mail call read_email");
		expect(ran.stderr).toContain('"messageId":"m1"');
	});

	it("takes other mail too with --unproved, and an earlier time with --since", async () => {
		const ran = await cli(
			[
				"code",
				"--to",
				"a@acme.example",
				"--from",
				"@github.com",
				"--subject",
				"verify",
				"--since",
				"2026-11-11T09:59:00+00:00",
				"--unproved",
				"--timeout",
				"30",
			],
			{ answers: [code("1")] },
		);
		expect(ran.code).toBe(0);
		expect(ran.asked[0]?.query).toEqual({
			to: "a@acme.example",
			from: "@github.com",
			subject: "verify",
			provedOnly: "false",
			since: "2026-11-11T09:59:00.000Z",
			timeoutSeconds: "30",
		});
	});

	it("says what it takes when it is used wrong", async () => {
		const usage = async (args: string[], words: RegExp) => {
			const ran = await cli(args);
			expect(ran.code).toBe(2);
			expect(ran.asked).toEqual([]);
			expect(ran.stderr).toMatch(words);
		};
		await usage(["code", "--to", "a@acme.example"], /takes --from/);
		await usage(["code", "--from", "github.com"], /takes --to/);
		await usage(
			["code", "--to", "a@acme.example", "--from", "x", "--timeout", "soon"],
			/--timeout/,
		);
		await usage(["code", "--to", "a@acme.example", "--from", "x", "--since", "now"], /--since/);
		await usage(
			["code", "--to", "a@acme.example", "--from", "x", "--frob"],
			/Unknown option '--frob'/,
		);
		// Never a flag for the key, and never what followed it.
		const flagged = await cli(["code", "--to", "a@acme.example", "--key", "gwm_from-a-flag"]);
		expect(flagged.code).toBe(2);
		expect(flagged.stderr).toMatch(/read only from GATEWEAVE_MAIL_KEY/);
		expect(flagged.stderr).not.toContain("gwm_from-a-flag");
	});

	it("needs Mail's address and the agent's key from the environment", async () => {
		const args = ["code", "--to", "a@acme.example", "--from", "github.com"];
		const noUrl = await cli(args, { env: { GATEWEAVE_MAIL_KEY: KEY } });
		expect(noUrl.code).toBe(2);
		expect(noUrl.stderr).toMatch(/^Set GATEWEAVE_MAIL_URL/);
		const noKey = await cli(args, { env: { GATEWEAVE_MAIL_URL: URL_ } });
		expect(noKey.code).toBe(2);
		expect(noKey.stderr).toMatch(/^Set GATEWEAVE_MAIL_KEY/);
		const flag = await cli([...args, "--url", "https://other.example/"], {
			env: { GATEWEAVE_MAIL_KEY: KEY },
			answers: [code("7")],
		});
		expect(flag.code).toBe(0);
	});

	it("says what a 401 and a 403 mean, without the key even when Mail repeats it", async () => {
		const args = ["code", "--to", "a@acme.example", "--from", "github.com"];
		const revoked = await cli(args, { answers: [json({ error: `No such key ${KEY}.` }, 401)] });
		expect(revoked.code).toBe(1);
		expect(revoked.stderr).toMatch(/wrong, or was revoked/);
		expect(revoked.stderr).toContain("No such key [key].");
		const paused = await cli(args, { answers: [json({ error: "This agent is paused." }, 403)] });
		expect(paused.code).toBe(1);
		expect(paused.stderr).toMatch(/grants or policy/);
	});

	it("says when Mail can't be reached", async () => {
		const ran = await cli(["code", "--to", "a@acme.example", "--from", "github.com"], {
			answers: [
				() => {
					throw new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND") });
				},
			],
		});
		expect(ran.code).toBe(1);
		expect(ran.stderr).toBe(`Couldn't reach Mail at ${URL_}: getaddrinfo ENOTFOUND.\n`);
	});
});

describe("gateweave-mail wait", () => {
	const message = { id: "m1", threadId: "t1", subject: "Welcome", text: "Hello." };

	it("prints the message as JSON, from a proved sender unless --unproved", async () => {
		const ran = await cli(["wait", "--to", "a@acme.example", "--subject", "Welcome"], {
			answers: [notYet, json({ found: true, message })],
		});
		expect(ran.code).toBe(0);
		expect(JSON.parse(ran.stdout)).toEqual(message);
		expect(ran.asked[0]).toMatchObject({
			path: "/api/v1/wait",
			query: { to: "a@acme.example", subject: "Welcome", provedOnly: "true" },
		});
		const any = await cli(["wait", "--mailbox", "Sign-ups", "--unproved"], {
			answers: [json({ found: true, message })],
		});
		expect(any.asked[0]?.query.provedOnly).toBe("false");
		expect(any.asked[0]?.query.from).toBeUndefined();
	});

	it("fails when nothing came in time", async () => {
		const ran = await cli(["wait", "--to", "a@acme.example", "--timeout", "10"], {
			answers: [notYet],
		});
		expect(ran.code).toBe(1);
		expect(ran.stderr).toMatch(/^No mail came in 10 seconds\./);
	});
});

describe("gateweave-mail send", () => {
	it("sends text with files, read and in Base64, and prints what became of it", async () => {
		const ran = await cli(
			[
				"send",
				"--mailbox",
				"Sign-ups",
				"--to",
				"one@example.org",
				"--to",
				"two@example.org",
				"--cc",
				"three@example.org",
				"--subject",
				"The report",
				"--text-file",
				"body.txt",
				"--attach",
				"out/report.csv",
				"--from",
				"signups@acme.example",
			],
			{
				files: { "body.txt": "See the file.", "out/report.csv": "a,b\n1,2\n" },
				answers: [json({ id: "m1", threadId: "t1", state: "held" })],
			},
		);
		expect(ran.code).toBe(0);
		expect(JSON.parse(ran.stdout)).toEqual({ id: "m1", threadId: "t1", state: "held" });
		expect(ran.stderr).toMatch(/waits for a person to approve it/);
		expect(ran.asked[0]).toMatchObject({
			method: "POST",
			path: "/api/v1/mailboxes/Sign-ups/messages",
			body: {
				to: ["one@example.org", "two@example.org"],
				cc: ["three@example.org"],
				subject: "The report",
				text: "See the file.",
				attachments: [{ filename: "report.csv", content: btoa("a,b\n1,2\n") }],
				from: "signups@acme.example",
			},
		});
	});

	it("sends HTML from a file, or text as given", async () => {
		const html = await cli(
			[
				"send",
				"--mailbox",
				"box",
				"--to",
				"a@example.org",
				"--subject",
				"Hi",
				"--html-file",
				"x.html",
			],
			{
				files: { "x.html": "<p>Hi</p>" },
				answers: [json({ id: "m", threadId: "t", state: "sent" })],
			},
		);
		expect(html.code).toBe(0);
		expect(html.stderr).toBe("");
		expect(html.asked[0]?.body).toEqual({
			to: ["a@example.org"],
			subject: "Hi",
			html: "<p>Hi</p>",
		});
		const text = await cli(
			["send", "--mailbox", "box", "--to", "a@example.org", "--subject", "Hi", "--text", "Hello."],
			{ answers: [json({ id: "m", threadId: "t", state: "sent" })] },
		);
		expect(text.asked[0]?.body).toEqual({ to: ["a@example.org"], subject: "Hi", text: "Hello." });
	});

	it("takes one body, the fields it needs, and files it can read", async () => {
		const base = ["send", "--mailbox", "box", "--to", "a@example.org", "--subject", "Hi"];
		for (const args of [
			base,
			[...base, "--text", "a", "--html-file", "x.html"],
			["send", "--mailbox", "box", "--subject", "Hi", "--text", "a"],
		]) {
			const ran = await cli(args);
			expect(ran.code, args.join(" ")).toBe(2);
			expect(ran.asked).toEqual([]);
		}
		const missing = await cli([...base, "--text", "a", "--attach", "nowhere.pdf"]);
		expect(missing.code).toBe(2);
		expect(missing.stderr).toMatch(/^Couldn't read nowhere\.pdf/);
	});

	it("says what Mail refused, and what was wrong in the request", async () => {
		const ran = await cli(
			["send", "--mailbox", "box", "--to", "a@example.org", "--subject", "Hi", "--text", "a"],
			{
				answers: [
					json(
						{
							error: "The request isn't one this route takes.",
							issues: [{ path: "to.0", message: "Invalid email" }],
						},
						400,
					),
				],
			},
		);
		expect(ran.code).toBe(1);
		expect(ran.stderr).toBe(
			"Mail answered 400 to send_email: The request isn't one this route takes.\n  to.0: Invalid email\n",
		);
	});
});

describe("gateweave-mail verify-webhook", () => {
	const secret = `whsec_${randomBytes(24).toString("base64")}`;
	const body = JSON.stringify({ type: "message.received", timestamp: "", data: {} });

	function signed(text = body) {
		const timestamp = String(Math.floor(Date.now() / 1000));
		const mac = createHmac("sha256", Buffer.from(secret.slice(6), "base64"))
			.update(`dlv_1.${timestamp}.${text}`)
			.digest("base64");
		return [
			"verify-webhook",
			"--id",
			"dlv_1",
			"--timestamp",
			timestamp,
			"--signature",
			`v1,${mac}`,
		];
	}

	const env = { GATEWEAVE_MAIL_WEBHOOK_SECRET: secret };

	it("prints the event's type when the signature holds, the body from stdin or a file", async () => {
		const piped = await cli(signed(), { env, stdin: body });
		expect(piped).toMatchObject({ code: 0, stdout: "message.received\n", stderr: "" });
		const filed = await cli([...signed(), "--body-file", "body.json"], {
			env,
			files: { "body.json": body },
		});
		expect(filed).toMatchObject({ code: 0, stdout: "message.received\n" });
	});

	it("fails, saying why, when it doesn't hold, and never shows the secret", async () => {
		const ran = await cli(signed(), { env, stdin: body.replace("received", "sent") });
		expect(ran.code).toBe(1);
		expect(ran.stdout).toBe("");
		expect(ran.stderr).toMatch(/^The signature doesn't hold\. Its signature doesn't match/);
		expect(ran.stderr).not.toContain(secret);
	});

	it("needs the secret from the environment, and a body", async () => {
		const noSecret = await cli(signed(), { env: {}, stdin: body });
		expect(noSecret.code).toBe(2);
		expect(noSecret.stderr).toMatch(/^Set GATEWEAVE_MAIL_WEBHOOK_SECRET/);
		const noBody = await cli(signed(), { env, tty: true });
		expect(noBody.code).toBe(2);
		expect(noBody.stderr).toMatch(/--body-file/);
		const notASecret = await cli(signed(), {
			env: { GATEWEAVE_MAIL_WEBHOOK_SECRET: "nope" },
			stdin: body,
		});
		expect(notASecret.code).toBe(2);
		const noId = await cli(["verify-webhook", "--timestamp", "1", "--signature", "v1,x"], { env });
		expect(noId.code).toBe(2);
	});
});

describe("gateweave-mail call", () => {
	it("calls any route by its operationId, or its method's name, with JSON from the argument or stdin", async () => {
		const listed = { mailboxes: [], sending: { perDay: 0, withoutApproval: [] } };
		const ran = await cli(["call", "list_mailboxes"], { answers: [json(listed)] });
		expect(ran.code).toBe(0);
		expect(JSON.parse(ran.stdout)).toEqual(listed);
		const read = await cli(["call", "readEmail", '{"mailbox": "Sign-ups", "messageId": "m 1"}'], {
			answers: [json({ message: { id: "m 1" } })],
		});
		expect(read.code).toBe(0);
		expect(read.asked[0]?.path).toBe("/api/v1/mailboxes/Sign-ups/messages/m%201");
		const piped = await cli(["call", "create_address"], {
			stdin: '{"mailbox": "box", "domain": "acme.example", "days": 2}',
			answers: [json({ id: "a1", address: "x@acme.example", expiresAt: null })],
		});
		expect(piped.asked[0]).toMatchObject({
			method: "POST",
			path: "/api/v1/mailboxes/box/addresses",
			body: { domain: "acme.example", days: 2 },
		});
		// At a terminal it doesn't wait for input nobody knows it wants.
		const tty = await cli(["call", "list_webhooks"], {
			tty: true,
			answers: [json({ webhooks: [] })],
		});
		expect(tty.code).toBe(0);
	});

	it("refuses what isn't a route or an input", async () => {
		for (const args of [
			["call"],
			["call", "frob"],
			["call", "list_mailboxes", "{nope"],
			["call", "list_mailboxes", "[1]"],
			["call", "list_mailboxes", "{}", "more"],
			["call", "read_email", '{"mailbox": "box"}'],
		]) {
			const ran = await cli(args);
			expect(ran.code, args.join(" ")).toBe(2);
			expect(ran.asked).toEqual([]);
		}
		const refused = await cli(["call", "end_address", '{"mailbox": "box", "addressId": "a1"}'], {
			answers: [json({ error: "No such mailbox or address of yours." }, 404)],
		});
		expect(refused.code).toBe(1);
		expect(refused.stderr).toMatch(/^Mail answered 404 to end_address: No such mailbox/);
	});
});

describe("gateweave-mail", () => {
	it("shows its help and version", async () => {
		const help = await cli(["--help"]);
		expect(help.code).toBe(0);
		expect(help.stdout).toMatch(/^Usage: gateweave-mail <command>/);
		expect(help.stdout).toContain("GATEWEAVE_MAIL_KEY");
		expect((await cli(["code", "-h"])).stdout).toBe(help.stdout);
		const version = await cli(["-v"]);
		const { version: packaged } = JSON.parse(
			readFileSync(new URL("../package.json", import.meta.url), "utf8"),
		);
		expect(version).toMatchObject({ code: 0, stdout: `${packaged}\n` });
		const nothing = await cli([]);
		expect(nothing.code).toBe(2);
		expect(nothing.stderr).toMatch(/^Usage/);
		const unknown = await cli(["frob"]);
		expect(unknown.code).toBe(2);
		expect(unknown.stderr).toMatch(/There is no command frob/);
	});
});
