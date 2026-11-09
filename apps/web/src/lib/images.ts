/**
 * The senders whose remote images show by themselves for the person reading, in one workspace:
 * domains that a message was proved to come from, and that they allowed. See
 * `server/mailbox/image-senders.ts`.
 */

/** One sender a person allows. */
export interface ImageSender {
	/** Lower case. */
	domain: string;
	allowedAt: number;
}

/** What `GET /api/images/<workspace>` answers. */
export interface ImageSendersPage {
	senders: ImageSender[];
}

/**
 * A change to the list: allow the domain that a message was proved to come from, which the server
 * reads from the message rather than taking a domain from the page, or stop allowing a domain.
 */
export type ImageAction =
	| { action: "allow"; mailbox: string; message: string }
	| { action: "stop"; domain: string };

export type ImageAnswer = { ok: true; domain: string } | { ok: false; error: string };

/** Where a person's senders for a workspace are listed and changed. */
export const imagesUrl = (workspace: string) => `/api/images/${encodeURIComponent(workspace)}`;

/** Changes the person's list, and says what came of it. */
export async function changeImageSenders(
	workspace: string,
	action: ImageAction,
): Promise<ImageAnswer> {
	try {
		const response = await fetch(imagesUrl(workspace), {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(action),
		});
		return (await response.json()) as ImageAnswer;
	} catch {
		return { ok: false, error: "That didn't reach the server. Try again." };
	}
}
