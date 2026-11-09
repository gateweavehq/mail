/**
 * `/api/images/<workspace>`: the senders whose remote images show by themselves for the person
 * signed in. Only people have it: an agent's key reads no HTML, and never reaches this.
 */
import { z } from "zod";
import type { ImageAnswer, ImageSendersPage } from "../lib/images";
import { currentMember } from "./access";
import { db } from "./auth";
import {
	allowImageSender,
	listImageSenders,
	MAX_IMAGE_SENDERS,
	stopImageSender,
} from "./mailbox/image-senders";
import { openMailbox } from "./mailbox/read";
import { appOrigin } from "./origin";

const Action = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("allow"),
		mailbox: z.string().min(1).max(64),
		message: z.string().min(1).max(64),
	}),
	// As long as a domain may be; one that isn't on the list is simply not there.
	z.object({ action: z.literal("stop"), domain: z.string().min(1).max(253) }),
]);

/** No caching: it is one person's, and changes at any moment. */
function answer(body: ImageAnswer | ImageSendersPage | { ok: false; error: string }, status = 200) {
	return Response.json(body, { status, headers: { "cache-control": "private, no-store" } });
}

/** The same whether the workspace, mailbox or message doesn't exist or isn't the caller's. */
const notFound = () => answer({ ok: false, error: "Not found" }, 404);

/** `GET /api/images/<workspace>`: the senders the person allows, the newest first. */
export async function readImageSenders(slug: string): Promise<Response> {
	const member = await currentMember(slug);
	if (!member) return notFound();
	return answer({ senders: await listImageSenders(db, member.membership.memberId) });
}

/**
 * `POST /api/images/<workspace>`: allows the domain a message of a mailbox the person reads was
 * proved to come from, or stops allowing a domain. The domain to allow comes from the message as
 * Mail judged it on arrival, never from the request, so nothing a sender wrote can be allowed.
 */
export async function changeImageSenders(request: Request, slug: string): Promise<Response> {
	// A session cookie comes along wherever a request is from, so ask where that is.
	if (request.headers.get("origin") !== appOrigin()) {
		return answer({ ok: false, error: "Not allowed from there" }, 403);
	}
	const parsed = Action.safeParse(await request.json().catch(() => null));
	if (!parsed.success) return answer({ ok: false, error: "That isn't a change we know." }, 400);
	const action = parsed.data;

	if (action.action === "stop") {
		const member = await currentMember(slug);
		if (!member) return notFound();
		const domain = action.domain.trim().toLowerCase();
		await stopImageSender(db, member.membership.memberId, domain);
		return answer({ ok: true, domain });
	}

	const box = await openMailbox(slug, action.mailbox, { people: true });
	const row = box ? await box.stub.get(action.message) : null;
	if (!box || !row) return notFound();
	if (!row.verifiedDomain) {
		return answer(
			{
				ok: false,
				error: "Nothing proves who sent this message, so images can't be allowed for its sender.",
			},
			400,
		);
	}
	const allowed = await allowImageSender(db, box.member.membership.memberId, row.verifiedDomain);
	if (!allowed) {
		return answer(
			{
				ok: false,
				error: `You allow images from ${MAX_IMAGE_SENDERS} senders already. Remove some in Settings, under Images.`,
			},
			409,
		);
	}
	return answer({ ok: true, domain: row.verifiedDomain });
}
