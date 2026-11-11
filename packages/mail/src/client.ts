import {
	type CallOptions,
	type MailMethods,
	type OperationId,
	type Operations,
	ROUTES,
	type Route,
} from "./api.gen.js";

// A client for Mail's agent API, made from the table of its routes rather than written route by
// route, so that a route the API adds is a method here as soon as the types are generated again.
// It runs wherever fetch does: browsers, Workers and Node alike.

/** A `fetch`, as the client calls one. */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface MailClientOptions {
	/** Mail's address, such as https://mail.example.com. */
	url: string;
	/** The agent's key, as an owner or admin made it in the workspace's settings, under Agents. */
	key: string;
	/** The fetch to make requests with instead of the global one, such as a test's. */
	fetch?: Fetch | undefined;
}

/** What is wrong in a request a route doesn't take. */
export interface Issue {
	/** Where in the input, such as `to.0`; empty for the input as a whole. */
	path: string;
	message: string;
}

/** Mail's answer when it didn't do what was asked: its status, and why in its own words. */
export class MailError extends Error {
	override readonly name = "MailError";
	/**
	 * The answer's status: 400 for a request the route doesn't take, 401 for a key that doesn't
	 * work, 403 for what the agent's grants or policy don't let it do, 404 for what it may not
	 * reach, 409 for what can't be done as things are, 429 for too many.
	 */
	readonly status: number;
	/** The route that answered, by its operationId. */
	readonly operation: string;
	/** For a request the route doesn't take, what in it is wrong. */
	readonly issues: Issue[];
	/** For a 429, in how many seconds to try again, when Mail says; null otherwise. */
	readonly retryAfter: number | null;

	constructor(
		message: string,
		{
			status,
			operation,
			issues = [],
			retryAfter = null,
		}: { status: number; operation: string; issues?: Issue[]; retryAfter?: number | null },
	) {
		super(message);
		this.status = status;
		this.operation = operation;
		this.issues = issues;
		this.retryAfter = retryAfter;
	}
}

/** The client's method for a route: send_email is sendEmail. */
export function methodOf(operation: string): string {
	return operation.replace(/_([a-z0-9])/g, (_, letter: string) => letter.toUpperCase());
}

// The methods MailMethods names are put on the class below, one for each route.
export interface MailClient extends MailMethods {}

/**
 * Mail's agent API, as an agent reaches it with its key. Each route is a method named for its
 * operationId in camelCase, such as `sendEmail` or `getVerificationCode`, which takes the route's
 * inputs in one object, as its MCP tool does, and gives its answer. When Mail doesn't do what was
 * asked, the method throws a `MailError`.
 */
// biome-ignore lint/suspicious/noUnsafeDeclarationMerging: the methods are made from ROUTES, below, and a test checks each route has one.
export class MailClient {
	/** Mail's address, without a slash at its end. */
	readonly url: string;
	readonly #key: string;
	readonly #fetch: Fetch;

	constructor({ url, key, fetch }: MailClientOptions) {
		const address = typeof url === "string" && URL.canParse(url) ? new URL(url) : null;
		if (address?.protocol !== "https:" && address?.protocol !== "http:") {
			throw new TypeError("MailClient takes Mail's address, such as https://mail.example.com.");
		}
		// Trimmed, as a key read from a file or a variable often ends in a newline, and checked, as
		// fetch would refuse one a header can't carry with an error that repeats it.
		const token = typeof key === "string" ? key.trim() : "";
		if (!/^[!-~]+$/.test(token)) {
			throw new TypeError("MailClient takes the agent's key.");
		}
		let end = address.href.length;
		while (address.href[end - 1] === "/") end -= 1;
		this.url = address.href.slice(0, end);
		this.#key = token;
		// Called on its own, the global fetch would lose the `this` browsers and Workers need.
		this.#fetch = fetch ?? ((input, init) => globalThis.fetch(input, init));
	}

	/** Calls a route by its operationId, as its method does. */
	async call<K extends OperationId>(
		operation: K,
		input?: Operations[K]["input"],
		options: CallOptions = {},
	): Promise<Operations[K]["output"]> {
		const route = (ROUTES as Record<string, Route | undefined>)[operation];
		if (!route) throw new TypeError(`Mail's agent API has no route ${operation}.`);
		const values: Record<string, unknown> = { ...input };
		const path = route.path.replace(/\{(\w+)\}/g, (_, name: string) => {
			const value = values[name];
			if (value === undefined || value === null || value === "") {
				throw new TypeError(`${methodOf(operation)} takes ${name}.`);
			}
			return encodeURIComponent(String(value));
		});
		// A query string's values as the API reads them: numbers as digits, booleans as true or false.
		const query = new URLSearchParams();
		for (const name of route.queryParams) {
			const value = values[name];
			if (value !== undefined && value !== null) query.set(name, String(value));
		}
		const elsewhere = new Set([...route.pathParams, ...route.queryParams]);
		const body = route.body
			? JSON.stringify(
					Object.fromEntries(Object.entries(values).filter(([name]) => !elsewhere.has(name))),
				)
			: undefined;
		const search = query.toString();
		const response = await this.#fetch(`${this.url}/api/v1${path}${search ? `?${search}` : ""}`, {
			method: route.method,
			headers: {
				authorization: `Bearer ${this.#key}`,
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			...(body === undefined ? {} : { body }),
			...(options.signal ? { signal: options.signal } : {}),
		});
		const answer = jsonOf(await response.text());
		if (response.ok && isObject(answer)) return answer as Operations[K]["output"];
		throw this.#failure(operation, response, answer);
	}

	/** The error for an answer that isn't what the route gives, in Mail's words where it has them. */
	#failure(operation: string, response: Response, answer: unknown): MailError {
		const said =
			isObject(answer) && typeof answer.error === "string"
				? answer.error
				: response.ok
					? "Mail's answer isn't the JSON object the route gives."
					: `Mail answered ${response.status}${response.statusText ? ` ${response.statusText}` : ""}.`;
		const issues =
			isObject(answer) && Array.isArray(answer.issues)
				? answer.issues.filter(isIssue).map((issue) => ({
						path: this.#hide(issue.path),
						message: this.#hide(issue.message),
					}))
				: [];
		return new MailError(this.#hide(said), {
			status: response.status,
			operation,
			issues,
			retryAfter: retryAfterOf(response.headers.get("retry-after")),
		});
	}

	/** Words from elsewhere, without the key, which nothing thrown may carry. */
	#hide(text: string): string {
		return text.split(this.#key).join("[key]");
	}
}

for (const operation of Object.keys(ROUTES) as OperationId[]) {
	Object.defineProperty(MailClient.prototype, methodOf(operation), {
		value(this: MailClient, input?: Record<string, unknown>, options?: CallOptions) {
			return this.call(operation, input as never, options);
		},
		writable: true,
		configurable: true,
	});
}

function jsonOf(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return undefined;
	}
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIssue(value: unknown): value is Issue {
	return isObject(value) && typeof value.path === "string" && typeof value.message === "string";
}

/** Retry-After in seconds, which may also be a date. */
function retryAfterOf(header: string | null): number | null {
	if (header === null) return null;
	const said = header.trim();
	if (/^\d+$/.test(said)) return Number(said);
	const at = Date.parse(said);
	return Number.isNaN(at) ? null : Math.max(0, Math.ceil((at - Date.now()) / 1000));
}
