import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { MAX_AGENT_WEBHOOKS, WEBHOOK_EVENTS } from "../../lib/webhooks";
import { ENDED_ADDRESS_KEPT_DAYS } from "../directory";
import { OPERATIONS } from "./operations";
import { OUTPUTS } from "./outputs";
import { LOOK_BACK_MS, MAX_WAIT_SECONDS, WAIT_SECONDS } from "./wait";

// The skill and the Claude Code plugin in plugins/gateweave-mail say how an agent uses this API,
// so they are held to it: a tool, route or input the skill names that the API doesn't have would
// send an agent wrong, and a tool it leaves out would go unexplained.

const plugin = new URL("../../../../../plugins/gateweave-mail/", import.meta.url);
const read = (path: string, root: URL = plugin) => readFileSync(new URL(path, root), "utf8");
const skill = read("skills/mail/SKILL.md");
const byName = new Map(OPERATIONS.map((operation) => [operation.name, operation]));

/** Calls `visit` on a schema and on every schema in it, however deep. */
function walk(schema: z.ZodType, visit: (schema: z.ZodType) => void, seen = new Set<unknown>()) {
	if (seen.has(schema)) return;
	seen.add(schema);
	visit(schema);
	const def = schema._zod.def as unknown as Record<string, unknown>;
	if (def.type === "object") {
		for (const value of Object.values(def.shape as Record<string, z.ZodType>)) {
			walk(value, visit, seen);
		}
	}
	for (const inner of ["innerType", "element", "in", "out", "valueType"]) {
		if (def[inner]) walk(def[inner] as z.ZodType, visit, seen);
	}
	for (const option of (def.options as z.ZodType[] | undefined) ?? []) walk(option, visit, seen);
}

/** Every field name the tools take or give, and every word their outputs put in quotes. */
function wordsOfTheApi(): Set<string> {
	const words = new Set<string>();
	const visit = (schema: z.ZodType) => {
		const def = schema._zod.def as unknown as Record<string, unknown>;
		if (def.type === "object") {
			for (const key of Object.keys(def.shape as object)) words.add(key);
		}
		// Such as a sent message's states: "held", "sent", "uncertain".
		for (const [, word] of (schema.description ?? "").matchAll(/"([a-z]+)"/g)) {
			words.add(word ?? "");
		}
	};
	for (const operation of OPERATIONS) walk(operation.input, visit);
	for (const output of Object.values(OUTPUTS)) walk(output as z.ZodType, visit);
	return words;
}

describe("the skill for agents", () => {
	it("is a skill named as its folder is, saying when to use it", () => {
		const front = /^---\n([\s\S]*?)\n---\n/.exec(skill.replaceAll("\r\n", "\n"))?.[1] ?? "";
		expect(front).toMatch(/^name: mail$/m);
		expect(front).toMatch(/^description: .*verification code.*$/m);
	});

	it("names every tool the API has, and none it doesn't", () => {
		const named = new Set(
			[...skill.matchAll(/`([a-z]+(?:_[a-z]+)+|reply)`/g)].map((match) => match[1] ?? ""),
		);
		expect([...named].filter((name) => !byName.has(name))).toEqual([]);
		expect(
			OPERATIONS.map((operation) => operation.name).filter((name) => !named.has(name)),
		).toEqual([]);
	});

	it("gives each tool's own REST route", () => {
		const routes = new Map<string, string>(
			OPERATIONS.flatMap((operation) =>
				operation.routes.map((route) => [`${route.method} ${route.path}`, operation.name] as const),
			),
		);
		const given = [...skill.matchAll(/`((?:GET|POST|PATCH|PUT|DELETE) \/[^`]*)`/g)].map(
			(match) => match[1] ?? "",
		);
		expect(given.length).toBeGreaterThan(10);
		expect(given.filter((route) => !routes.has(route))).toEqual([]);
		// Where it says "`tool` (`ROUTE`", the route is that tool's.
		for (const [, tool, route] of skill.matchAll(/`([a-z_]+)` \(`([A-Z]+ \/[^`]*)`/g)) {
			expect(routes.get(route ?? ""), route).toBe(tool);
		}
	});

	it("names only fields and words the tools take or give", () => {
		const words = new Set([
			...wordsOfTheApi(),
			...WEBHOOK_EVENTS,
			...byName.keys(),
			// REST's refusal body.
			"error",
		]);
		const named = [...skill.matchAll(/`([a-z][a-zA-Z]*(?:\.[a-zA-Z]+)*)`/g)]
			.map((match) => match[1] ?? "")
			// A domain, given as an example of one, is no field.
			.filter((name) => !/^[a-z]+\.(?:com|org|net)$/.test(name));
		expect(named.length).toBeGreaterThan(30);
		const unknown = named.filter(
			(name) => !words.has(name) && !name.split(".").every((part) => words.has(part)),
		);
		expect(unknown).toEqual([]);
	});

	it("gives the numbers the code has", () => {
		const flat = skill.replace(/\s+/g, " ");
		expect(flat).toContain(`(${WAIT_SECONDS} unless you say, ${MAX_WAIT_SECONDS} at most)`);
		expect(flat).toContain(`${LOOK_BACK_MS / 60_000} minutes before the call`);
		expect(flat).toContain(`You can have ${MAX_AGENT_WEBHOOKS} webhooks of your own`);
		expect(flat).toContain(`can't be made again for ${ENDED_ADDRESS_KEPT_DAYS} days.`);
	});

	it("tells agents to pass only inputs the tools take", () => {
		const takes = (tool: string) => Object.keys(byName.get(tool)?.input.shape ?? {});
		expect(takes("get_verification_code")).toEqual(
			expect.arrayContaining(["to", "from", "since", "timeoutSeconds", "provedOnly"]),
		);
		expect(takes("wait_for_email")).toEqual(
			expect.arrayContaining(["mailbox", "to", "from", "subject", "since"]),
		);
		expect(takes("search_email")).toContain("query");
		for (const tool of ["send_email", "reply"]) {
			expect(takes(tool)).toEqual(
				expect.arrayContaining(["text", "html", "attachments", "draftId", "context"]),
			);
		}
		expect(takes("send_email")).toEqual(expect.arrayContaining(["to", "cc", "subject", "from"]));
		expect(takes("create_address")).toEqual(expect.arrayContaining(["localPart", "days"]));
	});
});

describe("the Claude Code plugin", () => {
	const manifest = JSON.parse(read(".claude-plugin/plugin.json"));
	const servers = JSON.parse(read(".mcp.json")).mcpServers;
	const marketplace = JSON.parse(
		read(".claude-plugin/marketplace.json", new URL("../../", plugin)),
	);

	it("is offered by the repository's marketplace under its own name", () => {
		expect(marketplace.plugins).toEqual([
			expect.objectContaining({ name: manifest.name, source: "./plugins/gateweave-mail" }),
		]);
	});

	it("connects to Mail's MCP server with the key Claude Code keeps as a secret", () => {
		expect(servers).toEqual({
			mail: {
				type: "http",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's own placeholder, as the file has it.
				url: "${user_config.mcp_url}",
				headers: {
					// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's own placeholder too.
					Authorization: "Bearer ${user_config.mail_key}",
				},
			},
		});
		expect(manifest.userConfig.mail_key).toMatchObject({ sensitive: true, required: true });
		expect(manifest.userConfig.mcp_url).toMatchObject({ required: true });
		expect(manifest.userConfig.mcp_url.sensitive).toBeUndefined();
		// No version, so each commit is one, and a fix to the skill reaches whoever updates.
		expect(manifest.version).toBeUndefined();
	});
});
