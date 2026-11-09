import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { convertV4MiniflareOptions, Miniflare, type V4ModuleDefinition } from "miniflare";

const app = resolve(import.meta.dirname, "..");
const serverDir = join(app, "dist/server");

interface BuiltConfig {
	compatibility_date: string;
	compatibility_flags?: string[];
}

/** One line the Worker wrote to its console. */
export interface WorkerLog {
	level: string;
	message: string;
}

/** What Mail handed to its email binding. */
/** What the `EMAIL` binding was asked to send: account email, or mail from a mailbox. */
export interface SentEmail {
	from: string | { name: string; email: string };
	to: string | string[];
	cc?: string[];
	subject: string;
	text: string;
	html?: string;
	headers?: Record<string, string>;
	attachments?: {
		filename: string;
		type: string;
		disposition: "attachment" | "inline";
		contentId?: string;
		content: string;
	}[];
	/** The id `send()` gave back for it, as Email Service's delivery events name it. */
	messageId: string;
}

/** A message on a queue, as Cloudflare hands it to the Worker's `queue()`. */
export interface QueuedMessage {
	id: string;
	timestamp: Date;
	body: unknown;
	attempts: number;
}

/** What `queue()` did with a batch: which messages it acknowledged and which it wants again. */
export interface QueueOutcome {
	outcome: string;
	ackAll: boolean;
	retryBatch: { retry: boolean; delaySeconds?: number };
	explicitAcks: string[];
	retryMessages: { msgId: string; delaySeconds?: number }[];
}

/** What tests do with the bucket raw mail goes to. */
interface TestBucket {
	list(options: { prefix: string }): Promise<{ objects: { key: string }[] }>;
	get(key: string): Promise<{ arrayBuffer(): Promise<ArrayBuffer> } | null>;
	put(key: string, value: string | ArrayBuffer): Promise<unknown>;
}

/** The address Mail sends from in tests. */
export const EMAIL_FROM = { name: "Gateweave Mail", email: "mail@mail.test" };

/**
 * A caller that gives up: it passes a request to the last isolate through a service binding and aborts
 * after a moment, which cancels the request there as a client going away does in production. A client
 * hanging up on Miniflare does not.
 */
const IMPATIENT = `
export default {
	async fetch(request, env) {
		const target = new Request(new URL(request.url).searchParams.get("to"), request);
		try {
			return await env.TARGET.fetch(target, { signal: AbortSignal.timeout(300) });
		} catch {
			return new Response("Stopped waiting", { status: 504 });
		}
	},
};
`;

// Stands in for Cloudflare Email Service behind the EMAIL binding: `send` keeps each message,
// and a fetch lists them. A recipient's address can ask for a failure, as Email Service's would:
// "refuse-E_CODE@" is refused with that code; "busy-N@", "daily-N@" and "lost-N@" fail N times,
// busy, out of quota or with no code at all, then go.
const OUTBOX = `
import { WorkerEntrypoint } from "cloudflare:workers";
const sent = [];
const tries = new Map();
function failure(address) {
	const local = address.slice(0, address.indexOf("@"));
	const refused = /^refuse-(E_[A-Z_]+)$/.exec(local);
	if (refused) return new Error(refused[1] + ": refused for the test");
	const failing = /^(busy|daily|lost)-(\\d+)$/.exec(local);
	if (!failing) return null;
	const count = (tries.get(address) ?? 0) + 1;
	tries.set(address, count);
	if (count > Number(failing[2])) return null;
	if (failing[1] === "lost") return new Error("The connection went away");
	return new Error((failing[1] === "busy" ? "E_RATE_LIMIT_EXCEEDED" : "E_DAILY_LIMIT_EXCEEDED") + ": try later");
}
// As Email Service does (measured 2026-11-09), a file whose content is a string goes as those
// characters, not as the Base64 they spell. What went is kept as Base64, to compare with requests.
function asSent(file) {
	const content = file.content;
	const bytes =
		typeof content === "string"
			? new TextEncoder().encode(content)
			: ArrayBuffer.isView(content)
				? new Uint8Array(content.buffer, content.byteOffset, content.byteLength)
				: new Uint8Array(content);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return { ...file, content: btoa(binary) };
}
export default class Outbox extends WorkerEntrypoint {
	async send(message) {
		const recipients = [message.to, message.cc ?? []].flat();
		for (const address of recipients) {
			const error = failure(address);
			if (error) throw error;
		}
		const messageId = "<" + crypto.randomUUID() + "@outbox.test>";
		const attachments = message.attachments?.map(asSent);
		sent.push({ ...message, ...(attachments ? { attachments } : {}), messageId });
		return { messageId };
	}
	async fetch() {
		return Response.json(sent);
	}
}
`;

/** Every module of the built Worker. Its migrations are imported as text. */
function builtModules(): V4ModuleDefinition[] {
	const modules: V4ModuleDefinition[] = [];
	for (const file of readdirSync(serverDir, { recursive: true, encoding: "utf8" })) {
		const path = join(serverDir, file);
		if (file.endsWith(".js")) modules.push({ type: "ESModule", path });
		else if (file.endsWith(".sql")) modules.push({ type: "Text", path });
	}
	return modules;
}

/**
 * The built Worker in workerd, as deployed: D1 migrated and served at `origin` without a
 * network. Requests go in through `fetch`.
 *
 * Every outbound request fails, the way a deployed Worker's request to its own hostname does.
 * Mail needs no outside service for sign-in, so code that only works because local dev can
 * reach itself fails here instead of in production. Email is on, and lands in `emails()`.
 *
 * With `isolates` above 1, more copies of the Worker share the database and Durable Objects but
 * nothing in memory, as isolates in production do. `fetchIn` reaches a given one.
 *
 * Requests to a host in `hosts` reach its handler, as a provider elsewhere would be reached. The
 * other settings go in `settings`.
 */
export async function startMail(
	origin: string,
	{
		isolates = 1,
		hosts = {},
		withoutDatabase = false,
		withoutSecret = false,
		plainMail = false,
		settings = {},
		isolateSettings = [],
	}: {
		isolates?: number;
		hosts?: Record<string, (request: Request) => Response | Promise<Response>>;
		/** What a branch's Preview lacks. */
		withoutDatabase?: boolean;
		withoutSecret?: boolean;
		/** No `SECRETS_KEY`, so raw mail is kept as it comes, as before sealing. */
		plainMail?: boolean;
		settings?: Record<string, string>;
		/** Settings that only this copy has, as a deployment's old and new versions would differ. */
		isolateSettings?: Record<string, string>[];
	} = {},
) {
	const config = JSON.parse(readFileSync(join(serverDir, "wrangler.json"), "utf8")) as BuiltConfig;
	const outbound: string[] = [];
	const logs: WorkerLog[] = [];
	const modules = builtModules();
	const secret = randomBytes(32).toString("base64url");
	// Raw mail is sealed, as a deployment with this setting seals it. `settings` may name another.
	const secretsKey = randomBytes(32).toString("base64");
	const names = Array.from({ length: isolates }, (_, i) => (i === 0 ? "mail" : `mail-${i + 1}`));
	// Miniflare 5 still takes its documented v4 options through this converter.
	const mf = new Miniflare(
		convertV4MiniflareOptions({
			unsafeTriggerHandlers: true,
			// Keep what the Worker logs for `logs`, and still show it as Miniflare would.
			handleStructuredLogs: (log) => {
				logs.push(log);
				console.error(`[worker ${log.level}] ${log.message}`);
			},
			workers: [
				...names.map((name, index) => ({
					name,
					// Requests go to the first copy unless their host is another copy's route.
					routes: index === 0 ? [] : [`${name}.test/*`],
					modules,
					modulesRoot: serverDir,
					compatibilityDate: config.compatibility_date,
					compatibilityFlags: config.compatibility_flags,
					bindings: {
						...(withoutSecret ? {} : { BETTER_AUTH_SECRET: secret }),
						...(plainMail ? {} : { SECRETS_KEY: secretsKey }),
						BETTER_AUTH_URL: origin,
						EMAIL_FROM: `${EMAIL_FROM.name} <${EMAIL_FROM.email}>`,
						...settings,
						...isolateSettings[index],
					},
					serviceBindings: { EMAIL: "outbox" },
					d1Databases: { [withoutDatabase ? "UNBOUND_DB" : "DB"]: "mail-test" },
					r2Buckets: { RAW_MAIL: "mail-test" },
					// Every copy uses the first one's Durable Objects.
					durableObjects: {
						RATE_LIMITER: { className: "RateLimiter", useSQLite: true, scriptName: names[0] },
						MAILBOX: { className: "Mailbox", useSQLite: true, scriptName: names[0] },
						WEBHOOKS: { className: "Webhooks", useSQLite: true, scriptName: names[0] },
					},
					outboundService: (request: Request) => {
						outbound.push(request.url);
						const host = new URL(request.url).host;
						const handler = hosts[host];
						if (handler) return handler(request);
						return new Response("Outbound requests are blocked in this test", { status: 502 });
					},
				})),
				{
					name: "impatient",
					modules: true,
					script: IMPATIENT,
					routes: ["impatient.test/*"],
					compatibilityDate: config.compatibility_date,
					serviceBindings: { TARGET: names[names.length - 1] as string },
				},
				{
					name: "outbox",
					modules: true,
					script: OUTBOX,
					routes: ["outbox.test/*"],
					compatibilityDate: config.compatibility_date,
				},
			],
		}),
	);

	const db = await mf.getD1Database(withoutDatabase ? "UNBOUND_DB" : "DB");
	// Miniflare's types for the bucket don't come through, so this names the part tests use.
	const bucket = (await mf.getR2Bucket("RAW_MAIL")) as unknown as TestBucket;
	const migrations = join(app, "migrations");
	for (const file of readdirSync(migrations)
		.filter((name) => name.endsWith(".sql"))
		.sort()) {
		const statements = readFileSync(join(migrations, file), "utf8")
			.split("--> statement-breakpoint")
			.map((statement) => statement.trim())
			.filter(Boolean);
		await db.batch(statements.map((statement) => db.prepare(statement)));
	}

	/** A `fetch` that reaches one copy of the Worker directly. Redirects are returned. */
	async function fetchIn(
		isolate: number,
		input: string | URL | Request,
		init?: RequestInit,
	): Promise<Response> {
		const name = names[isolate];
		if (!name) throw new Error(`There are only ${names.length} isolates`);
		const request = new Request(input, init);
		const url = new URL(request.url);
		if (isolate > 0) url.host = `${name}.test`;
		const response = await mf.dispatchFetch(url, {
			method: request.method,
			headers: [...request.headers],
			body: request.body ? await request.arrayBuffer() : undefined,
			redirect: "manual",
		});
		const headers = new Headers();
		for (const [name, value] of response.headers) {
			if (name !== "set-cookie") headers.append(name, value);
		}
		for (const cookie of response.headers.getSetCookie()) headers.append("set-cookie", cookie);
		const empty = response.status === 204 || response.status === 304;
		return new Response(empty ? null : await response.arrayBuffer(), {
			status: response.status,
			headers,
		});
	}

	return {
		/** A `fetch` that reaches the Worker directly. Redirects are returned, not followed. */
		fetch: (input: string | URL | Request, init?: RequestInit) => fetchIn(0, input, init),
		fetchIn,
		/** Sends a request to the last isolate from a caller that stops waiting after a moment. */
		fetchAndStopWaiting: (url: string, init: RequestInit) =>
			mf.dispatchFetch(`http://impatient.test/?to=${encodeURIComponent(url)}`, {
				method: init.method,
				headers: [...new Headers(init.headers)],
				body: init.body as string,
			}),
		/**
		 * Opens a WebSocket to the Worker. Its status is 101 and `socket` is open, accepted, when
		 * the Worker took the upgrade.
		 */
		async connect(url: string, headers: Record<string, string>) {
			const response = await mf.dispatchFetch(url, {
				headers: { ...headers, Upgrade: "websocket" },
			});
			const socket = response.webSocket;
			socket?.accept();
			return { status: response.status, socket };
		},
		/** URLs the Worker tried to fetch from outside. */
		outbound,
		/** Everything the Worker has logged so far, oldest first. */
		logs,
		/** Every email sent so far, oldest first. Email goes out after the response. */
		async emails(): Promise<SentEmail[]> {
			const response = await mf.dispatchFetch("http://outbox.test/");
			return (await response.json()) as SentEmail[];
		},
		/** The D1 database, for setting up state the app has no endpoint for. */
		db,
		/** The bucket raw mail goes to, to see what is kept. */
		bucket,
		/** The Worker's `BETTER_AUTH_SECRET`, to check what it signs. */
		secret,
		/** Runs the Worker's Cron Trigger once, as Cloudflare would. */
		async runScheduled() {
			// Miniflare's Fetcher type leaves out the scheduled() workerd adds to every Worker stub.
			const worker = (await mf.getWorker(names[0])) as unknown as {
				scheduled(event: { cron: string; scheduledTime: Date }): Promise<unknown>;
			};
			await worker.scheduled({ cron: "29 3 * * *", scheduledTime: new Date() });
		},
		/** Hands a batch to the Worker's `queue()` handler, as Cloudflare Queues would. */
		async runQueue(queue: string, messages: QueuedMessage[]): Promise<QueueOutcome> {
			// As with scheduled(), Miniflare's Fetcher type leaves out what workerd adds.
			const worker = (await mf.getWorker(names[0])) as unknown as {
				queue(queue: string, messages: QueuedMessage[]): Promise<QueueOutcome>;
			};
			return worker.queue(queue, messages);
		},
		/**
		 * Delivers a message to the Worker's `email()` handler, as Cloudflare Email Routing would,
		 * and says whether the handler refused it, and why.
		 */
		async deliver(from: string, to: string, raw: string, isolate = 0) {
			const name = names[isolate];
			if (!name) throw new Error(`There are only ${names.length} isolates`);
			const host = isolate > 0 ? `${name}.test` : "localhost";
			const response = await mf.dispatchFetch(
				`http://${host}/cdn-cgi/local/email?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
				{ method: "POST", body: raw },
			);
			return { status: response.status, text: await response.text() };
		},
		dispose: () => mf.dispose(),
	};
}
