import { appOrigin } from "../origin";
import { readUpTo, textOf } from "../streams";
import { accessFor, agentOfRequest, type NoAgent, noAgentAnswer } from "./access";
import { ApiError, INTERNAL_FAILURE, logFailure } from "./mail-access";
import { API_PATH, hasBody, jsonSchema, openApiDocument, pathNames, takenBy } from "./openapi";
import { OPERATIONS, type Operation, type Route } from "./operations";

/** The most a request's body may be: a message's text is at most 100,000 characters. */
const MAX_BODY = 1_000_000;

/**
 * Any site may call the API from a browser, as a tool made from the document may: only a key in
 * `Authorization` counts, never a cookie, and a browser sends none of its own.
 */
const CORS = {
	"access-control-allow-origin": "*",
	"access-control-expose-headers": "retry-after, www-authenticate",
};

interface Known {
	operation: Operation;
	route: Route;
	pattern: RegExp;
	/** The names its path takes, in order. */
	names: string[];
	/** The inputs it takes besides its path's, with their JSON types, to read a query string. */
	taken: { name: string; type: unknown }[];
}

/** Every route, as a pattern for its path. */
const ROUTES: Known[] = OPERATIONS.flatMap((operation) => {
	const properties = jsonSchema(operation.input, "input").properties ?? {};
	return operation.routes.map((route) => ({
		operation,
		route,
		pattern: new RegExp(`^${route.path.replace(/\{\w+\}/g, "([^/]+)")}$`),
		names: pathNames(route),
		taken: takenBy(operation, route).map((name) => ({ name, type: properties[name]?.type })),
	}));
});

/** The document, written once for the origin it names. */
let written: { origin: string; text: string } | null = null;

function documentText(origin: string): string {
	if (written?.origin !== origin) {
		written = { origin, text: JSON.stringify(openApiDocument(origin)) };
	}
	return written.text;
}

/**
 * The agent API under /api/v1, for an agent with its key, and its OpenAPI document. Each route is
 * one of the agent's operations, which its MCP tools are too: the same input, the same answer, the
 * same functions underneath, with the request's own key. Session cookies are never enough: without
 * a key the answer is 401.
 */
export async function handleApiRequest(request: Request): Promise<Response> {
	const url = new URL(request.url);
	const path = url.pathname.slice(API_PATH.length) || "/";
	if (path === "/openapi.json") {
		if (request.method === "OPTIONS") return preflight("GET");
		if (request.method !== "GET") return failure("Only GET.", 405, { allow: "GET" });
		return new Response(documentText(appOrigin()), {
			headers: {
				...CORS,
				"content-type": "application/json",
				"cache-control": "public, max-age=300",
			},
		});
	}
	const here = ROUTES.map((known) => ({ known, found: known.pattern.exec(path) })).filter(
		({ found }) => found !== null,
	);
	if (here.length === 0) {
		return failure(`No such route. See ${API_PATH}/openapi.json.`, 404);
	}
	const allow = [...new Set(here.map(({ known }) => known.route.method))].join(", ");
	if (request.method === "OPTIONS") return preflight(allow);
	const matched = here.find(({ known }) => known.route.method === request.method);
	if (!matched?.found) return failure(`This route takes ${allow}.`, 405, { allow });
	const agent = await agentOfRequest(request);
	if (!("key" in agent)) return unauthorized(agent);

	const { known, found } = matched;
	const input = await inputOf(request, url, known, found);
	if (input instanceof Response) return input;
	const parsed = known.operation.input.safeParse(input);
	if (!parsed.success) {
		return failure(
			"The request isn't one this route takes.",
			400,
			{},
			{
				issues: parsed.error.issues.map((issue) => ({
					path: issue.path.join("."),
					message: issue.message,
				})),
			},
		);
	}
	const name = known.route.id ?? known.operation.name;
	try {
		const result = await known.operation.run(
			accessFor(agent.slug, agent.key),
			parsed.data,
			request.signal,
		);
		// As an MCP client checks a tool's answer against its schema, so that what the document
		// promises is what comes.
		const output = (known.route.output ?? known.operation.output).safeParse(result);
		if (!output.success) {
			logFailure(name, new TypeError("answer unlike its schema"));
			return failure(INTERNAL_FAILURE, 500);
		}
		return Response.json(result, { headers: { ...CORS, "cache-control": "private, no-store" } });
	} catch (error) {
		if (error instanceof ApiError) {
			const retry: Record<string, string> =
				error.retryAfter === null ? {} : { "retry-after": String(error.retryAfter) };
			return failure(error.message, error.status, retry);
		}
		logFailure(name, error);
		return failure(INTERNAL_FAILURE, 500);
	}
}

/**
 * What a request asks, from its path, then its query string for a GET or DELETE or its JSON body
 * for a POST or PATCH: only the inputs its route takes. A query string's numbers and booleans are read as
 * such, as the input has them; anything else is left for the input to refuse.
 */
async function inputOf(
	request: Request,
	url: URL,
	known: Known,
	found: RegExpExecArray,
): Promise<Record<string, unknown> | Response> {
	const fromPath: Record<string, string> = {};
	for (const [at, name] of known.names.entries()) {
		try {
			fromPath[name] = decodeURIComponent(found[at + 1] ?? "");
		} catch {
			return failure("A part of the path isn't encoded as a URL's is.", 400);
		}
	}
	const taken: Record<string, unknown> = {};
	if (hasBody(known.route)) {
		// Read only so far, whatever the request says its length is, or doesn't.
		const read = await readUpTo(request.body, known.operation.maxBody ?? MAX_BODY);
		if (!read) return failure("The request is too large.", 413);
		let body: unknown;
		try {
			body = JSON.parse(textOf(read));
		} catch {
			body = undefined;
		}
		if (typeof body !== "object" || body === null || Array.isArray(body)) {
			return failure("The body must be a JSON object.", 400);
		}
		for (const { name } of known.taken) {
			if (name in body) taken[name] = (body as Record<string, unknown>)[name];
		}
	} else {
		for (const { name, type } of known.taken) {
			const value = url.searchParams.get(name);
			if (value !== null) taken[name] = fromQuery(value, type);
		}
	}
	return { ...taken, ...fromPath };
}

function fromQuery(value: string, type: unknown): unknown {
	if (type === "boolean" && (value === "true" || value === "false")) return value === "true";
	if ((type === "integer" || type === "number") && /^-?\d+(?:\.\d+)?$/.test(value)) {
		return Number(value);
	}
	return value;
}

/** What a browser asks before it calls a route from another site. */
function preflight(allow: string): Response {
	return new Response(null, {
		status: 204,
		headers: {
			...CORS,
			"access-control-allow-methods": allow,
			"access-control-allow-headers": "authorization, content-type",
			"access-control-max-age": "86400",
		},
	});
}

function failure(
	error: string,
	status: number,
	headers: Record<string, string> = {},
	more: Record<string, unknown> = {},
): Response {
	return Response.json(
		{ error, ...more },
		{ status, headers: { ...CORS, ...headers, "cache-control": "private, no-store" } },
	);
}

function unauthorized(why: NoAgent): Response {
	const { error, status, challenge } = noAgentAnswer(
		why,
		"Mail's agent API takes an agent's key, as a bearer token. An owner or admin makes one in the workspace's settings, under Agents.",
	);
	return failure(error, status, status === 401 ? { "www-authenticate": challenge } : {});
}
