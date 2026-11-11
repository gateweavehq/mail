import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { OPERATIONS } from "./operations";

// The skill and the Claude Code plugin in plugins/gateweave-mail say how an agent uses this API,
// so they are held to it: a tool, route or input the skill names that the API doesn't have would
// send an agent wrong, and a tool it leaves out would go unexplained.

const plugin = new URL("../../../../../plugins/gateweave-mail/", import.meta.url);
const read = (path: string, root: URL = plugin) => readFileSync(new URL(path, root), "utf8");
const skill = read("skills/mail/SKILL.md");
const byName = new Map(OPERATIONS.map((operation) => [operation.name, operation]));

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

	it("connects to Mail's MCP server with the key from the credential store, never a file", () => {
		expect(servers).toEqual({
			mail: {
				type: "http",
				// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's own placeholder, as the file has it.
				url: "${user_config.mail_url}/mcp",
				headers: {
					// biome-ignore lint/suspicious/noTemplateCurlyInString: Claude Code's own placeholder too.
					Authorization: "Bearer ${user_config.mail_key}",
				},
			},
		});
		expect(manifest.userConfig.mail_key).toMatchObject({ sensitive: true, required: true });
		expect(manifest.userConfig.mail_url).toMatchObject({ required: true });
		expect(manifest.userConfig.mail_url.sensitive).toBeUndefined();
	});
});
