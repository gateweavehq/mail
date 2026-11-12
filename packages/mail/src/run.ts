import { Buffer } from "node:buffer";
import { basename } from "node:path";
import { type ParseArgsOptionsConfig, parseArgs } from "node:util";
import { type OperationId, ROUTES } from "./api.gen.js";
import { type Fetch, MailClient, MailError, methodOf } from "./client.js";
import { VERSION } from "./version.js";
import { verifyWebhook, WebhookError } from "./webhooks.js";

// The gateweave-mail command, for what a script or a CI job needs of Mail: a sign-in code, a
// message, a send, a webhook's signature checked, or any route. `run` takes the world it works in,
// so tests run it in this process; cli.ts gives it the real one.

/** What the command reaches the world through. */
export interface CliIO {
	/** GATEWEAVE_MAIL_URL, GATEWEAVE_MAIL_KEY and GATEWEAVE_MAIL_WEBHOOK_SECRET come from here. */
	env: Record<string, string | undefined>;
	/** Everything on standard input. */
	stdin(): Promise<Uint8Array>;
	/** Whether standard input is a terminal, which a command then doesn't wait on. */
	stdinIsTTY?: boolean | undefined;
	stdout(text: string): void;
	stderr(text: string): void;
	readFile(path: string): Promise<Uint8Array>;
	/** The fetch to reach Mail with, when not the global one. */
	fetch?: Fetch | undefined;
	/** The time in milliseconds, and a pause: the clock's unless a test gives its own. */
	now?: (() => number) | undefined;
	sleep?: ((ms: number) => Promise<void>) | undefined;
}

const DONE = 0;
/** Mail refused, nothing came, or a signature doesn't hold. */
const FAILED = 1;
/** Wrong usage, or a setting missing. */
const USAGE = 2;

/** How long `code` and `wait` wait in all, unless told. */
const TIMEOUT_SECONDS = 120;
/** The longest one wait the API takes, its MAX_WAIT_SECONDS. */
const MAX_WAIT_SECONDS = 50;
/** How much longer than a wait its answer may take before the command stops waiting for it. */
const ANSWER_GRACE_MS = 30_000;

/** Usage that can't work, said in words to act on. */
class Usage extends Error {}

/** Mail that couldn't be reached at all. */
class Unreachable extends Error {}

const HELP = `Usage: gateweave-mail <command> [options]

Gateweave Mail's agent API from a shell, a script or a CI job, with an agent's key.

Commands:
  code             Wait for a verification code, and print only the code.
  wait             Wait for a message, and print it as JSON.
  send             Send a message, and print what became of it as JSON.
  verify-webhook   Check a webhook delivery's signature, and print its event's type.
  call             Call any route of the API, and print its answer as JSON.

code and wait:
  --from <sender>      Only mail from this address, or from this domain or one under it,
                       such as github.com. code needs it.
  --to <address>       Only mail that came to this address. Give it, --mailbox, or both.
  --mailbox <mailbox>  The mailbox, by its id, its name or one of its addresses.
  --subject <words>    Only mail whose subject has these words.
  --since <time>       Only mail that arrived at or after this ISO 8601 time. Without it, only
                       mail that arrives once the command has started: take the time before
                       you set off the mail, and pass it here.
  --timeout <seconds>  How long to wait in all; ${TIMEOUT_SECONDS} unless you say.
  --unproved           Take mail whose sender DMARC didn't prove too.

send:
  --mailbox <mailbox>  The mailbox to send from.
  --to <address>       Who it goes to; again for each more.
  --cc <address>       Who gets a copy; again for each more.
  --subject <subject>  Its subject.
  --text <text>, --text-file <file> or --html-file <file>
                       What it says, one of the three.
  --attach <file>      A file it carries; again for each more.
  --from <address>     One of the mailbox's addresses; its first unless you say.

verify-webhook:
  --id <id>, --timestamp <time>, --signature <signature>
                       The delivery's webhook-id, webhook-timestamp and webhook-signature.
  --body-file <file>   Its body, as it came; from standard input without it.

call <operationId> [<input>]:
  The input is a JSON object, from standard input when left out. The routes:
${wrapped(Object.keys(ROUTES).join(", "), "  ")}

Options:
  --url <url>      Your Mail's address, instead of GATEWEAVE_MAIL_URL.
  -h, --help       Show this.
  -v, --version    Show the version.

Environment:
  GATEWEAVE_MAIL_URL             Your Mail's address, such as https://mail.example.com.
  GATEWEAVE_MAIL_KEY             The agent's key. Read only from here, never from a flag, so
                                 that it stays out of shell history and lists of processes.
  GATEWEAVE_MAIL_WEBHOOK_SECRET  The webhook's whsec_ secret, for verify-webhook.

Exit codes: 0 done; 1 Mail refused, nothing came, or the signature doesn't hold;
2 wrong usage, or a setting missing.
`;

const URL_OPTION = { url: { type: "string" } } as const;
const HELP_OPTION = { help: { type: "boolean", short: "h" } } as const;
const WAIT_OPTIONS = {
	...URL_OPTION,
	...HELP_OPTION,
	from: { type: "string" },
	to: { type: "string" },
	mailbox: { type: "string" },
	subject: { type: "string" },
	since: { type: "string" },
	timeout: { type: "string" },
	unproved: { type: "boolean" },
} as const;
const SEND_OPTIONS = {
	...URL_OPTION,
	...HELP_OPTION,
	mailbox: { type: "string" },
	to: { type: "string", multiple: true },
	cc: { type: "string", multiple: true },
	subject: { type: "string" },
	text: { type: "string" },
	"text-file": { type: "string" },
	"html-file": { type: "string" },
	attach: { type: "string", multiple: true },
	from: { type: "string" },
} as const;
const VERIFY_OPTIONS = {
	...HELP_OPTION,
	id: { type: "string" },
	timestamp: { type: "string" },
	signature: { type: "string" },
	"body-file": { type: "string" },
} as const;
const CALL_OPTIONS = { ...URL_OPTION, ...HELP_OPTION } as const;

/** Runs the command these arguments name, and gives the code to exit with. */
export async function run(args: string[], io: CliIO): Promise<number> {
	const secrets = [io.env.GATEWEAVE_MAIL_KEY, io.env.GATEWEAVE_MAIL_WEBHOOK_SECRET].filter(
		(secret): secret is string => Boolean(secret),
	);
	// Whatever is said on stderr, the key and the secret are never in it.
	const say = (text: string) =>
		io.stderr(`${secrets.reduce((said, secret) => said.split(secret).join("[hidden]"), text)}\n`);
	try {
		return await command(args, io, say);
	} catch (error) {
		if (error instanceof Usage || error instanceof TypeError) {
			say(`${error.message}\nSee gateweave-mail --help.`);
			return USAGE;
		}
		if (error instanceof MailError) {
			say(refusal(error));
			return FAILED;
		}
		say(error instanceof Unreachable ? error.message : `gateweave-mail failed: ${String(error)}`);
		return FAILED;
	}
}

async function command(args: string[], io: CliIO, say: (text: string) => void): Promise<number> {
	const [name, ...rest] = args;
	// Said before anything reads the arguments, whose errors would repeat what follows the flag.
	if (args.some((arg) => /^--(key|secret|token)(=|$)/.test(arg))) {
		throw new Usage(
			"The key and the webhook's secret are read only from GATEWEAVE_MAIL_KEY and GATEWEAVE_MAIL_WEBHOOK_SECRET, never from a flag, so that they stay out of shell history and lists of processes.",
		);
	}
	if (name === undefined) {
		say(HELP);
		return USAGE;
	}
	if (name === "-h" || name === "--help" || name === "help") {
		io.stdout(HELP);
		return DONE;
	}
	if (name === "-v" || name === "--version") {
		io.stdout(`${VERSION}\n`);
		return DONE;
	}
	if (rest.includes("-h") || rest.includes("--help")) {
		io.stdout(HELP);
		return DONE;
	}
	switch (name) {
		case "code":
		case "wait":
			return waitFor(name, rest, io, say);
		case "send":
			return send(rest, io, say);
		case "verify-webhook":
			return verify(rest, io, say);
		case "call":
			return call(rest, io);
		default:
			throw new Usage(`There is no command ${name}.`);
	}
}

/** `code` and `wait`: the API's bounded wait, again and again until the command's time is up. */
async function waitFor(
	kind: "code" | "wait",
	args: string[],
	io: CliIO,
	say: (text: string) => void,
): Promise<number> {
	const { values } = parsed(args, WAIT_OPTIONS);
	const { from, to, mailbox, subject } = values;
	if (kind === "code" && !from) {
		throw new Usage("code takes --from, the sender: an address, or a domain such as github.com.");
	}
	if (!to && !mailbox) {
		throw new Usage(`${kind} takes --to, the address the mail comes to, or --mailbox, or both.`);
	}
	const timeout = values.timeout === undefined ? TIMEOUT_SECONDS : secondsOf(values.timeout);
	const client = clientOf(values.url, io);
	const now = io.now ?? Date.now;
	const sleep = io.sleep ?? pause;
	const started = now();
	// The API alone would take mail from the 5 minutes before too, such as an older code.
	const since = values.since === undefined ? new Date(started).toISOString() : isoOf(values.since);
	const deadline = started + timeout * 1000;
	const filters = { mailbox, to, from, subject, since, provedOnly: !values.unproved };

	for (;;) {
		const asked = now();
		const timeoutSeconds = Math.min(
			MAX_WAIT_SECONDS,
			Math.ceil(Math.max(0, deadline - asked) / 1000),
		);
		const signal = AbortSignal.timeout(timeoutSeconds * 1000 + ANSWER_GRACE_MS);
		try {
			if (kind === "code") {
				const answer = await client.getVerificationCode(
					{ ...filters, from: from ?? "", timeoutSeconds },
					{ signal },
				);
				if (answer.found && answer.code) {
					io.stdout(`${answer.code}\n`);
					return DONE;
				}
				if (answer.found) {
					const read = JSON.stringify({ mailbox: mailbox ?? to, messageId: answer.messageId });
					say(
						`A message came from ${answer.fromDomain ?? "the sender"}, but Mail could tell no code apart in it. Read it with:\n  gateweave-mail call read_email '${read}'`,
					);
					return FAILED;
				}
			} else {
				const answer = await client.waitForEmail({ ...filters, timeoutSeconds }, { signal });
				if (answer.found && answer.message) {
					io.stdout(`${JSON.stringify(answer.message, null, 2)}\n`);
					return DONE;
				}
			}
		} catch (error) {
			// Too many waits for now: wait as long as Mail says, if the time left allows it.
			const wait = error instanceof MailError && error.status === 429 ? error.retryAfter : null;
			if (wait === null || now() + wait * 1000 >= deadline) throw error;
			say(`Mail says to wait ${wait} seconds before waiting for mail again. Waiting.`);
			await sleep(wait * 1000);
			continue;
		}
		if (now() >= deadline) break;
		// A wait that came back at once, as when Mail stopped it, isn't asked again at once.
		if (now() - asked < 1000) await sleep(1000);
	}
	const what = kind === "code" ? `No code from ${from}` : "No mail";
	const after =
		values.since === undefined
			? "once the command had started (--since takes an earlier time)"
			: `since ${since}`;
	const proved = values.unproved ? "" : ", from a proved sender (--unproved takes others too)";
	say(`${what} came in ${timeout} seconds. Only mail that arrived ${after}${proved} counts.`);
	return FAILED;
}

async function send(args: string[], io: CliIO, say: (text: string) => void): Promise<number> {
	const { values } = parsed(args, SEND_OPTIONS);
	const { mailbox, to = [], cc, subject } = values;
	if (!mailbox || to.length === 0 || !subject) {
		throw new Usage("send takes --mailbox, --to and --subject.");
	}
	const bodies = [values.text, values["text-file"], values["html-file"]].filter(
		(body) => body !== undefined,
	);
	if (bodies.length !== 1) {
		throw new Usage(
			"send takes what the message says as one of --text, --text-file or --html-file.",
		);
	}
	const client = clientOf(values.url, io);
	const textFile = values["text-file"];
	const htmlFile = values["html-file"];
	const text = textFile === undefined ? values.text : textOf(await read(io, textFile));
	const html = htmlFile === undefined ? undefined : textOf(await read(io, htmlFile));
	const attachments = await Promise.all(
		(values.attach ?? []).map(async (path) => ({
			filename: basename(path),
			content: Buffer.from(await read(io, path)).toString("base64"),
		})),
	);
	const sent = await client.sendEmail({
		mailbox,
		to,
		cc,
		subject,
		text,
		html,
		attachments: attachments.length > 0 ? attachments : undefined,
		from: values.from,
	});
	io.stdout(`${JSON.stringify(sent, null, 2)}\n`);
	if (sent.state === "held") {
		say("It waits for a person to approve it, as the agent's policy has for mail to anyone else.");
	}
	return DONE;
}

async function verify(args: string[], io: CliIO, say: (text: string) => void): Promise<number> {
	const { values } = parsed(args, VERIFY_OPTIONS);
	const { id, timestamp, signature } = values;
	if (!id || !timestamp || !signature) {
		throw new Usage(
			"verify-webhook takes --id, --timestamp and --signature: the delivery's webhook-id, webhook-timestamp and webhook-signature.",
		);
	}
	const secret = io.env.GATEWEAVE_MAIL_WEBHOOK_SECRET;
	if (!secret) {
		throw new Usage(
			"Set GATEWEAVE_MAIL_WEBHOOK_SECRET to the webhook's whsec_ secret, as Mail gave it when the webhook was made.",
		);
	}
	const file = values["body-file"];
	const body =
		file === undefined
			? await input(io, "verify-webhook takes the body with --body-file, or on standard input.")
			: await read(io, file);
	try {
		const event = await verifyWebhook({
			secret,
			headers: { "webhook-id": id, "webhook-timestamp": timestamp, "webhook-signature": signature },
			body,
		});
		io.stdout(`${typeof event.type === "string" ? event.type : "(no type)"}\n`);
		return DONE;
	} catch (error) {
		if (!(error instanceof WebhookError)) throw error;
		say(`The signature doesn't hold. ${error.message}`);
		return FAILED;
	}
}

async function call(args: string[], io: CliIO): Promise<number> {
	const { values, positionals } = parsed(args, CALL_OPTIONS, true);
	const [name, given, ...more] = positionals;
	const ids = Object.keys(ROUTES) as OperationId[];
	if (!name) throw new Usage(`call takes a route's operationId, one of: ${ids.join(", ")}.`);
	const operation = ids.find((id) => id === name || methodOf(id) === name);
	if (!operation) throw new Usage(`There is no route ${name}. The routes: ${ids.join(", ")}.`);
	if (more.length > 0) throw new Usage("call takes its input as one JSON argument: quote it.");
	const client = clientOf(values.url, io);
	const text = given ?? (io.stdinIsTTY ? "" : textOf(await io.stdin()));
	let data: unknown = {};
	try {
		if (text.trim()) data = JSON.parse(text);
	} catch {
		throw new Usage("call's input isn't JSON.");
	}
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		throw new Usage(`call's input is a JSON object, such as {"mailbox": "Sign-ups"}.`);
	}
	const answer = await client.call(operation, data as never);
	io.stdout(`${JSON.stringify(answer, null, 2)}\n`);
	return DONE;
}

/** A client for Mail's address and the agent's key, which only the environment gives. */
function clientOf(url: string | undefined, io: CliIO): MailClient {
	const address = url ?? io.env.GATEWEAVE_MAIL_URL;
	if (!address) {
		throw new Usage(
			"Set GATEWEAVE_MAIL_URL to your Mail's address, such as https://mail.example.com, or pass --url.",
		);
	}
	const key = io.env.GATEWEAVE_MAIL_KEY;
	if (!key) {
		throw new Usage(
			"Set GATEWEAVE_MAIL_KEY to the agent's key, which an owner or admin makes in the workspace's settings, under Agents.",
		);
	}
	const reach = io.fetch ?? ((to: string, init: RequestInit) => globalThis.fetch(to, init));
	return new MailClient({
		url: address,
		key,
		async fetch(to, init) {
			try {
				return await reach(to, init);
			} catch (error) {
				const why =
					error instanceof Error && error.name === "TimeoutError"
						? "it didn't answer in time"
						: error instanceof Error
							? error.cause instanceof Error
								? error.cause.message
								: error.message
							: String(error);
				throw new Unreachable(`Couldn't reach Mail at ${address}: ${why}.`);
			}
		},
	});
}

/** What a refusal means, with what to do about it. */
function refusal(error: MailError): string {
	const lines = [`Mail answered ${error.status} to ${error.operation}: ${error.message}`];
	for (const issue of error.issues) lines.push(`  ${issue.path || "input"}: ${issue.message}`);
	if (error.status === 401) {
		lines.push(
			"The key in GATEWEAVE_MAIL_KEY is wrong, or was revoked, or its agent was deleted. An owner or admin makes a new one in the workspace's settings, under Agents.",
		);
	} else if (error.status === 403) {
		lines.push(
			"The agent's grants or policy don't let it do this, or it is paused. An owner or admin changes them in the workspace's settings, under Agents.",
		);
	} else if (error.status === 429 && error.retryAfter !== null) {
		lines.push(`Try again in ${error.retryAfter} seconds.`);
	}
	return lines.join("\n");
}

function parsed<T extends ParseArgsOptionsConfig>(
	args: string[],
	options: T,
	allowPositionals = false,
) {
	try {
		return parseArgs({ args, options, allowPositionals, strict: true });
	} catch (error) {
		throw new Usage(error instanceof Error ? error.message : String(error));
	}
}

async function read(io: CliIO, path: string): Promise<Uint8Array> {
	try {
		return await io.readFile(path);
	} catch (error) {
		throw new Usage(`Couldn't read ${path}: ${error instanceof Error ? error.message : error}`);
	}
}

/** Standard input, unless it is a terminal, where nobody would know it waits. */
function input(io: CliIO, otherwise: string): Promise<Uint8Array> {
	if (io.stdinIsTTY) throw new Usage(otherwise);
	return io.stdin();
}

function textOf(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

function secondsOf(value: string): number {
	if (!/^\d+(\.\d+)?$/.test(value)) throw new Usage("--timeout takes a number of seconds.");
	return Number(value);
}

function isoOf(value: string): string {
	const at = Date.parse(value);
	if (Number.isNaN(at)) {
		throw new Usage("--since takes an ISO 8601 time, such as 2026-11-11T09:59:00Z.");
	}
	return new Date(at).toISOString();
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Words wrapped to lines of at most 80 characters, each indented. */
function wrapped(words: string, indent: string): string {
	const lines: string[] = [];
	let line = "";
	for (const word of words.split(" ")) {
		if (line && indent.length + line.length + 1 + word.length > 80) {
			lines.push(indent + line);
			line = word;
		} else {
			line = line ? `${line} ${word}` : word;
		}
	}
	if (line) lines.push(indent + line);
	return lines.join("\n");
}
