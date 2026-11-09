/**
 * The senders whose remote images show by themselves for the person reading, in one workspace:
 * domains that a message was proved to come from, and that they allowed. See
 * `server/mailbox/image-senders.ts`.
 */

import { useSyncExternalStore } from "react";

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

/**
 * What the reader chose for a sender while this page has been open, by workspace and domain.
 * Messages they opened earlier keep what the server said when they loaded, and a thread's older
 * messages load once; this is how a choice reaches them all at once, without loading them again.
 */
const choices = new Map<string, boolean>();
const listeners = new Set<() => void>();

const choiceKey = (workspace: string, domain: string) => `${workspace}\n${domain.toLowerCase()}`;

function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

/** Records what the reader chose for a sender, for every message of theirs on the page. */
export function rememberImageChoice(workspace: string, domain: string, allowed: boolean) {
	choices.set(choiceKey(workspace, domain), allowed);
	for (const listener of listeners) listener();
}

/** What the reader chose for a sender since the page opened, or null when they haven't. */
export function useImageChoice(workspace: string, domain: string | null): boolean | null {
	return useSyncExternalStore(
		subscribe,
		() => (domain ? (choices.get(choiceKey(workspace, domain)) ?? null) : null),
		() => null,
	);
}
