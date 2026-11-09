import { Validator } from "@seriousme/openapi-schema-validator";
import { describe, expect, it } from "vitest";
import { openApiDocument, pathNames, takenBy } from "./openapi";
import { OPERATIONS } from "./operations";

const document = openApiDocument("https://mail.example.com");

describe("the agent API's OpenAPI document", () => {
	it("is a valid OpenAPI 3.1 document", async () => {
		const result = await new Validator().validate(document);
		expect(result.errors ?? []).toEqual([]);
		expect(result.valid).toBe(true);
		expect(document.servers).toEqual([{ url: "https://mail.example.com/api/v1" }]);
	});

	it("has a route for every MCP tool, each named once", () => {
		const tools = OPERATIONS.map((operation) => operation.name);
		expect(new Set(tools).size).toBe(tools.length);
		const ids: string[] = [];
		for (const path of Object.values(document.paths)) {
			for (const route of Object.values(path) as { operationId: string; "x-mcp-tool": string }[]) {
				ids.push(route.operationId);
				expect(tools).toContain(route["x-mcp-tool"]);
			}
		}
		expect(new Set(ids).size).toBe(ids.length);
		expect(new Set(ids)).toEqual(new Set([...tools, "read_thread"]));
	});

	it("takes on each route only what its operation does", () => {
		for (const operation of OPERATIONS) {
			const inputs = Object.keys(operation.input.shape);
			for (const route of operation.routes) {
				for (const name of [...pathNames(route), ...takenBy(operation, route)]) {
					expect(inputs, `${route.method} ${route.path}`).toContain(name);
				}
			}
		}
	});

	it("says what a send needs, and that a wait's numbers and booleans are such", () => {
		const send = document.paths["/mailboxes/{mailbox}/messages"]?.post as {
			parameters: { name: string; in: string; required: boolean }[];
			requestBody: {
				content: { "application/json": { schema: { required: string[]; properties: object } } };
			};
		};
		expect(send.parameters).toEqual([expect.objectContaining({ name: "mailbox", in: "path" })]);
		const body = send.requestBody.content["application/json"].schema;
		// Text, HTML or both, which the send itself checks.
		expect(body.required.sort()).toEqual(["subject", "to"]);
		expect(Object.keys(body.properties)).toEqual(
			expect.arrayContaining(["text", "html", "attachments"]),
		);
		expect(Object.keys(body.properties)).not.toContain("mailbox");

		const wait = document.paths["/verification-code"]?.get as {
			parameters: { name: string; required: boolean; schema: { type: string } }[];
		};
		const byName = Object.fromEntries(wait.parameters.map((one) => [one.name, one]));
		expect(byName.from?.required).toBe(true);
		expect(byName.to?.required).toBe(false);
		expect(byName.timeoutSeconds?.schema.type).toBe("integer");
		expect(byName.provedOnly?.schema.type).toBe("boolean");
	});

	it("gives each read route the answer it gives, and says what else may come", () => {
		const answer = (path: string, method = "get") => {
			const route = document.paths[path]?.[method] as {
				responses: Record<string, { content?: { "application/json": { schema: Schema } } }>;
			};
			return route.responses;
		};
		type Schema = { required?: string[] };
		const message = answer("/mailboxes/{mailbox}/messages/{messageId}");
		expect(message["200"]?.content?.["application/json"].schema.required).toEqual(["message"]);
		const thread = answer("/mailboxes/{mailbox}/threads/{threadId}");
		expect(thread["200"]?.content?.["application/json"].schema.required).toEqual(["thread"]);
		expect(Object.keys(answer("/mailboxes/{mailbox}/messages", "post"))).toEqual(
			expect.arrayContaining(["403", "409", "413", "429"]),
		);
		expect(document.components.responses.Failed429).toHaveProperty("headers.Retry-After");
	});

	it("takes a webhook's changes as a JSON body, and its test and deletion by its path", () => {
		type Route = {
			parameters: { name: string; in: string }[];
			requestBody?: {
				content: { "application/json": { schema: { required: string[]; properties: object } } };
			};
		};
		const one = document.paths["/webhooks/{webhookId}"] as { patch: Route; delete: Route };
		expect(one.patch.parameters).toEqual([
			expect.objectContaining({ name: "webhookId", in: "path" }),
		]);
		const body = one.patch.requestBody?.content["application/json"].schema;
		expect(Object.keys(body?.properties ?? {}).sort()).toEqual([
			"active",
			"events",
			"mailboxes",
			"newSecret",
			"url",
		]);
		expect(body?.required).toEqual([]);
		expect(one.delete.parameters).toEqual([
			expect.objectContaining({ name: "webhookId", in: "path" }),
		]);
		expect(one.delete.requestBody).toBeUndefined();
		const made = document.paths["/webhooks"]?.post as Route;
		expect(made.requestBody?.content["application/json"].schema.required.sort()).toEqual([
			"events",
			"url",
		]);
	});
});
