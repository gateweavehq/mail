import { z } from "zod";
import type { FailureStatus } from "./mail-access";
import { OPERATIONS, type Operation, type Route } from "./operations";
import { UNTRUSTED } from "./untrusted";

/** Where the agent API's routes are. */
export const API_PATH = "/api/v1";

/** A JSON Schema, as zod writes one. */
interface Schema {
	type?: string | string[];
	description?: string;
	properties?: Record<string, Schema>;
	required?: string[];
	[keyword: string]: unknown;
}

/** An operation's input or output as JSON Schema, as OpenAPI 3.1 takes it. */
export function jsonSchema(schema: z.ZodType, io: "input" | "output"): Schema {
	const { $schema: _, ...rest } = z.toJSONSchema(schema, { target: "draft-2020-12", io }) as Schema;
	return rest;
}

/** The names a route takes from its path, in order. */
export const pathNames = (route: Route) =>
	[...route.path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "");

/** The inputs a route takes besides its path's. */
export function takenBy(operation: Operation, route: Route): string[] {
	const inPath = pathNames(route);
	return route.takes ?? Object.keys(operation.input.shape).filter((name) => !inPath.includes(name));
}

const FAILURE_WORDS: Record<FailureStatus | 413 | 500, string> = {
	400: "The request isn't one it takes, or names no mailbox, message or address it can tell.",
	401: "No agent key, or one that doesn't work: revoked, or its agent deleted.",
	403: "Your key may not do this here, as your grants or policy have it.",
	404: "No such mailbox, message, thread or address that you may reach.",
	409: "It can't be done as things are, as when what you answer names nobody.",
	413: "The body is larger than any request takes.",
	429: "Too many for now. Retry-After, when there, says in how many seconds to try again.",
	500: "Mail couldn't do it just now. Try again.",
};

/** The OpenAPI document of the agent API, served at /api/v1/openapi.json. */
export function openApiDocument(origin: string) {
	const paths: Record<string, Record<string, unknown>> = {};
	for (const operation of OPERATIONS) {
		const input = jsonSchema(operation.input, "input");
		const properties = input.properties ?? {};
		const required = new Set(input.required ?? []);
		for (const route of operation.routes) {
			const output = jsonSchema(route.output ?? operation.output, "output");
			const taken = takenBy(operation, route);
			const parameter = (name: string, place: "path" | "query") => {
				const { description, ...schema } = properties[name] ?? {};
				return {
					name,
					in: place,
					required: place === "path" || required.has(name),
					...(description ? { description } : {}),
					schema,
				};
			};
			const parameters = [
				...pathNames(route).map((name) => parameter(name, "path")),
				...(route.method === "POST" ? [] : taken.map((name) => parameter(name, "query"))),
			];
			const body: Schema = {
				type: "object",
				properties: Object.fromEntries(taken.map((name) => [name, properties[name] ?? {}])),
				required: taken.filter((name) => required.has(name)),
			};
			const failures = [
				...new Set([
					400,
					401,
					404,
					...operation.refusals,
					...(route.method === "POST" ? [413] : []),
					500,
				]),
			].sort((a, b) => a - b);
			paths[route.path] = {
				...paths[route.path],
				[route.method.toLowerCase()]: {
					operationId: route.id ?? operation.name,
					summary: route.summary ?? operation.title,
					description: operation.description,
					"x-mcp-tool": operation.name,
					...(parameters.length > 0 ? { parameters } : {}),
					...(route.method === "POST"
						? { requestBody: { required: true, content: { "application/json": { schema: body } } } }
						: {}),
					responses: {
						"200": {
							description: "Done.",
							content: { "application/json": { schema: output } },
						},
						...Object.fromEntries(
							failures.map((status) => [
								String(status),
								{ $ref: `#/components/responses/Failed${status}` },
							]),
						),
					},
				},
			};
		}
	}
	return {
		openapi: "3.1.0",
		info: {
			title: "Gateweave Mail agent API",
			version: "1.0.0",
			description: [
				"What an AI agent can do with Gateweave Mail, with its key: read and search the mailboxes it was given, wait for mail and sign-in codes, send and reply, and make addresses of its own. Each operation is also a tool of Mail's MCP server, at /mcp, named in x-mcp-tool.",
				"An owner or admin makes the agent and its key in the workspace's settings, under Agents. The key names the workspace; send it as a bearer token. Mail an agent writes to anyone its policy doesn't name waits for a person to approve it.",
				`Mail is how a stranger reaches an agent. ${UNTRUSTED}`,
			].join("\n\n"),
			license: { name: "AGPL-3.0-only", identifier: "AGPL-3.0-only" },
		},
		servers: [{ url: `${origin}${API_PATH}` }],
		security: [{ agentKey: [] }],
		paths,
		components: {
			securitySchemes: {
				agentKey: {
					type: "http",
					scheme: "bearer",
					description: "The agent's key, as the agents settings page gave it.",
				},
			},
			schemas: {
				Failure: {
					type: "object",
					properties: {
						error: { type: "string", description: "Why, in words to act on." },
						issues: {
							type: "array",
							description: "For a request it doesn't take, what in it is wrong.",
							items: {
								type: "object",
								properties: { path: { type: "string" }, message: { type: "string" } },
								required: ["path", "message"],
							},
						},
					},
					required: ["error"],
				},
			},
			responses: Object.fromEntries(
				Object.entries(FAILURE_WORDS).map(([status, words]) => [
					`Failed${status}`,
					{
						description: words,
						...(status === "429"
							? {
									headers: {
										"Retry-After": {
											description: "In how many seconds to try again, when known.",
											schema: { type: "integer", minimum: 0 },
										},
									},
								}
							: {}),
						content: { "application/json": { schema: { $ref: "#/components/schemas/Failure" } } },
					},
				]),
			),
		},
	};
}
