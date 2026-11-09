import { z } from "zod";
import { isAdminRole } from "../../lib/roles";
import { currentMember } from "../access";
import { db } from "../auth";
import { appOrigin } from "../origin";
import { listSuppressions, readCursor, removeSuppression } from "./index";

const Action = z.object({ action: z.literal("remove"), id: z.string().min(1).max(64) });

export type SuppressionAction = z.input<typeof Action>;

/** No caching: this names people's addresses, and changes at any moment. */
function answer(body: unknown, status = 200): Response {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** The same whether the workspace doesn't exist or the caller isn't in it. */
const notFound = () => answer({ ok: false, error: "Not found" }, 404);

/** The longest search, as long as an address may be. */
const MAX_QUERY = 254;

/**
 * Who is asking, when they may see the list: an owner or admin, signed in. Agents and other members
 * don't see it, as it names people the workspace wrote to.
 */
async function admin(slug: string): Promise<{ refused: Response } | { workspaceId: string }> {
	const member = await currentMember(slug);
	if (!member) return { refused: notFound() };
	if (!isAdminRole(member.membership.role)) {
		return {
			refused: answer({ ok: false, error: "Only an owner or admin can see suppressions." }, 403),
		};
	}
	return { workspaceId: member.membership.workspaceId };
}

/** `GET /api/suppressions/<workspace>?q=<part of an address>&before=<cursor>`. */
export async function readSuppressions(request: Request, slug: string): Promise<Response> {
	const caller = await admin(slug);
	if ("refused" in caller) return caller.refused;
	const url = new URL(request.url);
	const query = url.searchParams.get("q")?.trim().slice(0, MAX_QUERY) || null;
	const before = readCursor(url.searchParams.get("before"));
	return answer(await listSuppressions(db, caller.workspaceId, { query, before }, Date.now()));
}

/** `POST /api/suppressions/<workspace>`: takes an entry off the list. */
export async function changeSuppressions(request: Request, slug: string): Promise<Response> {
	// A session cookie comes along wherever a request is from, so ask where that is.
	if (request.headers.get("origin") !== appOrigin()) {
		return answer({ ok: false, error: "Not allowed from there" }, 403);
	}
	const caller = await admin(slug);
	if ("refused" in caller) return caller.refused;
	const parsed = Action.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return answer({ ok: false, error: "That isn't a change we know." }, 400);
	// `gone` tells the page that the entry is off the list, as it would be had this removed it.
	return (await removeSuppression(db, caller.workspaceId, parsed.data.id, Date.now()))
		? answer({ ok: true })
		: answer({ ok: false, error: "It isn't on the list any more.", gone: true }, 404);
}
