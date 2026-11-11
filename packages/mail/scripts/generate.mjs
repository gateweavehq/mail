// Makes src/api.gen.ts, the types and routes of Mail's agent API, from openapi.json, the API's
// OpenAPI document, which a test in apps/web keeps as Mail writes it. `generate` only turns one
// into the other, so a test can check that the file is what the document makes.
//
//   pnpm --filter @gateweave/mail generate
//
// It turns only the part of JSON Schema that zod writes for the API into TypeScript, and stops at
// anything else rather than guess at it.

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * A JSON Schema, as the document has one.
 * @typedef {{
 *   type?: string | string[];
 *   description?: string;
 *   properties?: Record<string, Schema>;
 *   required?: string[];
 *   additionalProperties?: boolean | Schema;
 *   items?: Schema;
 *   anyOf?: Schema[];
 *   enum?: unknown[];
 *   const?: unknown;
 *   [keyword: string]: unknown;
 * }} Schema
 */

/**
 * @typedef {{ name: string; in: string; required?: boolean; description?: string; schema?: Schema }} Parameter
 * @typedef {{ content?: Record<string, { schema?: Schema }>; $ref?: string }} Content
 * @typedef {{
 *   operationId?: string;
 *   summary?: string;
 *   description?: string;
 *   "x-mcp-tool"?: string;
 *   parameters?: Parameter[];
 *   requestBody?: Content;
 *   responses?: Record<string, Content>;
 * }} Operation
 * @typedef {{ paths?: Record<string, Record<string, Operation>> }} Document
 */

const METHODS = ["get", "post", "put", "patch", "delete"];

/** What says how a value is made, which its TypeScript type follows. */
const SHAPES = new Set([
	"type",
	"properties",
	"required",
	"additionalProperties",
	"items",
	"anyOf",
	"enum",
	"const",
]);

/** What only describes or limits a value, which its TypeScript type leaves out. */
const LIMITS = new Set([
	"description",
	"title",
	"default",
	"examples",
	"format",
	"pattern",
	"minLength",
	"maxLength",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"minItems",
	"maxItems",
	"uniqueItems",
	"minProperties",
	"maxProperties",
	"readOnly",
	"writeOnly",
	"deprecated",
]);

/**
 * The TypeScript of Mail's agent API for a client, from its OpenAPI document: each route's input
 * and output, the table of its routes, and the client's methods.
 * @param {Document} document
 * @returns {string}
 */
export function generate(document) {
	/** @type {string[]} */
	const types = [];
	/** @type {string[]} */
	const operations = [];
	/** @type {string[]} */
	const routes = [];
	/** @type {string[]} */
	const methods = [];
	const ids = new Set();

	for (const [path, item] of Object.entries(document.paths ?? {})) {
		for (const [method, operation] of Object.entries(item)) {
			if (!METHODS.includes(method)) throw new Error(`${path} has a ${method} route.`);
			const id = operation.operationId;
			const where = `${method.toUpperCase()} ${path}`;
			if (!id || !/^[a-z][a-z0-9_]*$/.test(id)) {
				throw new Error(`${where} has no operationId in snake_case: ${id}`);
			}
			if (ids.has(id)) throw new Error(`Two routes are called ${id}.`);
			ids.add(id);

			const name = pascal(id);
			const parameters = operation.parameters ?? [];
			const inPath = [...path.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? "");
			const named = (/** @type {string} */ place) => parameters.filter((one) => one.in === place);
			const pathParams = named("path").map((one) => one.name);
			if (pathParams.join() !== inPath.join()) {
				throw new Error(`${where} names ${pathParams.join()} in its path, not ${inPath.join()}.`);
			}
			const queryParams = named("query");
			const others = parameters.filter((one) => one.in !== "path" && one.in !== "query");
			if (others[0]) throw new Error(`${where} takes ${others[0].name} in its ${others[0].in}.`);
			for (const one of queryParams) {
				// The API reads one value for each name in a query string, so a list can't go there.
				const kinds = [one.schema?.type].flat();
				if (
					!kinds.every((kind) => ["string", "number", "integer", "boolean"].includes(`${kind}`))
				) {
					throw new Error(`${where} takes ${one.name} in its query, as ${kinds.join()}.`);
				}
			}
			const body = json(operation.requestBody, `${where}'s body`);
			if (body && body.type !== "object") throw new Error(`${where}'s body isn't an object.`);

			/** @type {Record<string, Schema>} */
			const properties = {};
			/** @type {string[]} */
			const required = [];
			const take = (/** @type {string} */ key, /** @type {Schema} */ schema, needed = false) => {
				if (key in properties) throw new Error(`${where} takes ${key} twice.`);
				properties[key] = schema;
				if (needed) required.push(key);
			};
			for (const one of [...named("path"), ...queryParams]) {
				const schema = one.schema ?? {};
				const description = one.description ?? schema.description;
				take(one.name, { ...schema, ...(description ? { description } : {}) }, one.required);
			}
			const bodyRequired = new Set(body?.required ?? []);
			for (const [key, schema] of Object.entries(body?.properties ?? {})) {
				take(key, schema, bodyRequired.has(key));
			}
			const output = json(operation.responses?.["200"], `${where}'s answer`);
			if (!output) throw new Error(`${where} has no JSON answer for a 200.`);

			const methodName = camel(id);
			types.push(
				declaration(
					`${name}Input`,
					{ type: "object", properties, required },
					`${id} input`,
					true,
					`What \`${methodName}\` takes: the inputs of its path, query string and body in one.`,
				),
				declaration(
					`${name}Output`,
					output,
					`${id} output`,
					false,
					`What \`${methodName}\` gives.`,
				),
			);
			operations.push(`\t${id}: { input: ${name}Input; output: ${name}Output };`);
			routes.push(
				[
					`\t${id}: {`,
					`\t\tmethod: ${JSON.stringify(method.toUpperCase())},`,
					`\t\tpath: ${JSON.stringify(path)},`,
					`\t\tpathParams: ${list(pathParams)},`,
					`\t\tqueryParams: ${list(queryParams.map((one) => one.name))},`,
					`\t\tbody: ${body !== null},`,
					"\t},",
				].join("\n"),
			);
			const tool = operation["x-mcp-tool"];
			const words = [
				operation.summary ? `${operation.summary}.` : "",
				operation.description ?? "",
				`\`${where}\`${tool ? `, as the MCP tool \`${tool}\`` : ""}.`,
			];
			const optional = required.length === 0 ? "?" : "";
			methods.push(
				[
					...comment(words.filter(Boolean).join("\n\n"), "\t"),
					`\t${methodName}(input${optional}: ${name}Input, options?: CallOptions): Promise<${name}Output>;`,
				].join("\n"),
			);
		}
	}

	return `${[
		"// Generated by scripts/generate.mjs from openapi.json, the agent API's OpenAPI document. Don't",
		"// edit it by hand: change the operations in apps/web/src/server/agent-api, update the",
		"// document's snapshot, then run `pnpm --filter @gateweave/mail generate`.",
		"",
		"/** What every method takes beside its input. */",
		"export interface CallOptions {",
		"\t/** Stops the request, and the wait for its answer. */",
		"\tsignal?: AbortSignal | undefined;",
		"}",
		"",
		"/** Where a route is, and where its inputs go. */",
		"export interface Route {",
		`\tmethod: ${METHODS.map((one) => JSON.stringify(one.toUpperCase())).join(" | ")};`,
		"\t/** Its path under /api/v1, with each `{name}` an input taken from the path. */",
		"\tpath: string;",
		"\t/** The inputs that go in the path, in its order. */",
		"\tpathParams: readonly string[];",
		"\t/** The inputs that go in the query string, one value each. */",
		"\tqueryParams: readonly string[];",
		"\t/** Whether the other inputs go in a JSON body. */",
		"\tbody: boolean;",
		"}",
		"",
		types.join("\n\n"),
		"",
		"/** Each route's input and output, by its operationId. */",
		"export interface Operations {",
		...operations,
		"}",
		"",
		"/** A route's name, as the OpenAPI document's operationId has it. */",
		"export type OperationId = keyof Operations;",
		"",
		"/** Every route, by its operationId. */",
		"export const ROUTES = {",
		...routes,
		"} as const satisfies Record<OperationId, Route>;",
		"",
		"/** The client's methods: one for each route, named for its operationId in camelCase. */",
		"export interface MailMethods {",
		methods.join("\n\n"),
		"}",
	].join("\n")}\n`;
}

/** An operationId in PascalCase: send_email is SendEmail. */
export function pascal(/** @type {string} */ id) {
	return id
		.split("_")
		.filter(Boolean)
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join("");
}

/** An operationId in camelCase, as the client's method is called: send_email is sendEmail. */
export function camel(/** @type {string} */ id) {
	const name = pascal(id);
	return name.charAt(0).toLowerCase() + name.slice(1);
}

/**
 * The JSON schema of a body or an answer, or null when it has none.
 * @param {Content | undefined} content
 * @param {string} where
 * @returns {Schema | null}
 */
function json(content, where) {
	if (!content) return null;
	const schema = content.content?.["application/json"]?.schema;
	if (!schema) throw new Error(`${where} isn't JSON.`);
	return schema;
}

/**
 * An exported type or interface, with its words.
 * @param {string} name
 * @param {Schema} schema
 * @param {string} at
 * @param {boolean} input
 * @param {string} words
 */
function declaration(name, schema, at, input, words) {
	const lines = comment(words, "");
	if (schema.type === "object") {
		const shape = typeOf(schema, at, "", input).text;
		lines.push(
			shape.startsWith("{")
				? `export interface ${name} ${shape}`
				: `export type ${name} = ${shape};`,
		);
	} else {
		lines.push(`export type ${name} = ${typeOf(schema, at, "", input).text};`);
	}
	return lines.join("\n");
}

/**
 * A schema's TypeScript type. `union` says whether it is several, which a list needs in brackets.
 * Inputs say `| undefined` beside what they may leave out, so that they take it under
 * exactOptionalPropertyTypes too.
 * @param {Schema} schema
 * @param {string} at Where the schema is, for an error.
 * @param {string} indent The indentation of the line the type starts on.
 * @param {boolean} input
 * @returns {{ text: string; union: boolean }}
 */
function typeOf(schema, at, indent, input) {
	for (const keyword of Object.keys(schema)) {
		if (!SHAPES.has(keyword) && !LIMITS.has(keyword)) {
			throw new Error(`${at} has ${keyword}, which generate.mjs doesn't turn into TypeScript.`);
		}
	}
	const kinds = schema.type === undefined ? [] : [schema.type].flat();
	if (schema.anyOf) {
		if (kinds.length > 0 || schema.enum || "const" in schema) {
			throw new Error(`${at} has anyOf beside other types.`);
		}
		return union(
			schema.anyOf.map((one, n) => typeOf(one, `${at}.anyOf[${n}]`, indent, input).text),
		);
	}
	if (schema.enum) return union(schema.enum.map((value) => JSON.stringify(value)));
	if ("const" in schema) return union([JSON.stringify(schema.const)]);
	if (kinds.length === 0) {
		if (schema.properties || schema.items) throw new Error(`${at} has no type.`);
		return union(["unknown"]);
	}
	return union(
		kinds.map((kind) => {
			switch (kind) {
				case "string":
					return "string";
				case "number":
				case "integer":
					return "number";
				case "boolean":
					return "boolean";
				case "null":
					return "null";
				case "array": {
					const item = schema.items
						? typeOf(schema.items, `${at}[]`, indent, input)
						: { text: "unknown", union: false };
					return item.union ? `(${item.text})[]` : `${item.text}[]`;
				}
				case "object":
					return objectOf(schema, at, indent, input);
				default:
					throw new Error(`${at} has the type ${kind}.`);
			}
		}),
	);
}

/**
 * An object's type, with each property's words. One open to more properties, as `{}` for
 * additionalProperties says, takes any other key too.
 * @param {Schema} schema
 * @param {string} at
 * @param {string} indent
 * @param {boolean} input
 */
function objectOf(schema, at, indent, input) {
	const inner = `${indent}\t`;
	const required = new Set(schema.required ?? []);
	const more = schema.additionalProperties;
	const open = more === true || (typeof more === "object" && Object.keys(more).length === 0);
	if (typeof more === "object" && !open) {
		throw new Error(`${at} takes more properties of a type, which generate.mjs doesn't write.`);
	}
	const lines = [];
	for (const [name, property] of Object.entries(schema.properties ?? {})) {
		const key = /^[A-Za-z_$][\w$]*$/.test(name) ? name : JSON.stringify(name);
		const type = typeOf(property, `${at}.${name}`, inner, input).text;
		lines.push(...comment(property.description, inner));
		lines.push(
			required.has(name)
				? `${inner}${key}: ${type};`
				: `${inner}${key}?: ${type}${input ? " | undefined" : ""};`,
		);
	}
	if (open) lines.push(`${inner}[key: string]: unknown;`);
	if (lines.length === 0) return "Record<string, never>";
	return `{\n${lines.join("\n")}\n${indent}}`;
}

/** Strings as a TypeScript array. */
function list(/** @type {string[]} */ texts) {
	return `[${texts.map((text) => JSON.stringify(text)).join(", ")}]`;
}

/** Types as one, each once. */
function union(/** @type {string[]} */ texts) {
	const each = [...new Set(texts)];
	return { text: each.join(" | "), union: each.length > 1 };
}

/**
 * A doc comment of these words, at this indentation.
 * @param {string | undefined} words
 * @param {string} indent
 * @returns {string[]}
 */
function comment(words, indent) {
	if (!words) return [];
	const lines = words.replaceAll("*/", "*\\/").split("\n");
	if (lines.length === 1) return [`${indent}/** ${lines[0]} */`];
	return [
		`${indent}/**`,
		...lines.map((line) => (line.trim() ? `${indent} * ${line.trimEnd()}` : `${indent} *`)),
		`${indent} */`,
	];
}

const here = fileURLToPath(import.meta.url);
const run =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === here.toLowerCase());
if (run) {
	const root = new URL("../", import.meta.url);
	const document = JSON.parse(readFileSync(new URL("openapi.json", root), "utf8"));
	writeFileSync(new URL("src/api.gen.ts", root), generate(document));
	console.log("Wrote src/api.gen.ts from openapi.json.");
}
