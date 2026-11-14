import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { isAdminRole, isPersonRole } from "../../lib/roles";
import type { TemplateAnswer, WorkspaceTemplates } from "../../lib/workspace-templates";
import { currentMember } from "../access";
import { db } from "../auth";
import { schema } from "../db";
import { appOrigin } from "../origin";
import { audienceStub } from "./index";

const Action = z.discriminatedUnion("action", [
	// What the template holds is read by the object, which decides, so it isn't read twice here.
	z.object({
		action: z.literal("save"),
		id: z.string().min(1).max(64).nullable(),
		input: z.unknown(),
	}),
	z.object({ action: z.literal("remove"), id: z.string().min(1).max(64) }),
]);

/** No caching: a template changes at any moment, and what it says is the workspace's. */
function answer(body: TemplateAnswer<Record<string, unknown>>, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** The names of the members that saved versions, as the workspace has them now. */
async function namesOf(
	workspaceId: string,
	ids: (string | null)[],
): Promise<Record<string, string>> {
	const wanted = [...new Set(ids.flatMap((id) => id ?? []))];
	const names: Record<string, string> = {};
	const { member, user } = schema;
	// D1 binds at most 100 values in a statement.
	for (let at = 0; at < wanted.length; at += 90) {
		const rows = await db
			.select({ memberId: member.id, name: user.name })
			.from(member)
			.innerJoin(user, eq(member.userId, user.id))
			.where(
				and(eq(member.organizationId, workspaceId), inArray(member.id, wanted.slice(at, at + 90))),
			)
			.all();
		for (const row of rows) names[row.memberId] = row.name;
	}
	return names;
}

/** What the templates page shows. The caller must be a person who is a member of the workspace. */
export async function readTemplates(workspaceId: string): Promise<WorkspaceTemplates> {
	const templates = await audienceStub(workspaceId).list();
	return {
		templates,
		people: await namesOf(
			workspaceId,
			templates.map((one) => one.madeBy),
		),
	};
}

/**
 * `GET /api/templates/<workspace>?template=<id>`: a template's versions, newest first, for anyone
 * who is a person in the workspace. The same "not found" for a workspace or a template that isn't
 * there, or that the caller can't see.
 */
export async function templateVersions(request: Request, slug: string): Promise<Response> {
	const member = await currentMember(slug);
	if (!member || !isPersonRole(member.membership.role)) {
		return answer({ ok: false, error: "Not found" }, 404);
	}
	const id = new URL(request.url).searchParams.get("template") ?? "";
	const { workspaceId } = member.membership;
	const versions = id.length > 64 ? null : await audienceStub(workspaceId).versions(id);
	if (!versions) return answer({ ok: false, error: "Not found" }, 404);
	const people = await namesOf(
		workspaceId,
		versions.map((one) => one.madeBy),
	);
	return answer({ ok: true, versions, people });
}

/**
 * `POST /api/templates/<workspace>`: saves a template, as a new one or a new version of one, or
 * removes one. Only an owner or admin may: a template is what a workspace's mail says, whoever
 * sends it.
 */
export async function changeTemplates(request: Request, slug: string): Promise<Response> {
	// A session cookie comes along wherever a request is from, so ask where that is.
	if (request.headers.get("origin") !== appOrigin()) {
		return answer({ ok: false, error: "Not allowed from there." }, 403);
	}
	const member = await currentMember(slug);
	// The same whether the workspace doesn't exist or the caller isn't in it.
	if (!member) return answer({ ok: false, error: "Not found" }, 404);
	if (!isAdminRole(member.membership.role)) {
		return answer({ ok: false, error: "Only an owner or admin can change templates." }, 403);
	}
	const parsed = Action.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return answer({ ok: false, error: "That isn't a change we know." }, 400);
	const audience = audienceStub(member.membership.workspaceId);
	const change = parsed.data;
	if (change.action === "remove") {
		const removed = await audience.remove(change.id);
		return removed.ok
			? answer({ ok: true })
			: answer({ ok: false, error: removed.error }, removed.status);
	}
	const saved = await audience.save(change.id, change.input, member.membership.memberId);
	if (!saved.ok) return answer({ ok: false, error: saved.error }, saved.status);
	return answer({ ok: true, template: saved.template });
}
