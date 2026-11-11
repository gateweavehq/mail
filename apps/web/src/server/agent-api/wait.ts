import type { ListedMessage, MailboxPage, MessageCursor } from "../../lib/mailbox";
import { type AgentMailbox, ApiError, findMailbox, gone, type MailAccess } from "./mail-access";

/** The longest pause between a wait's looks at the mailbox. */
const MAX_PAUSE_MS = 5000;
/** How long a wait lasts unless asked otherwise, and at most: under MCP clients' usual 60 s. */
export const WAIT_SECONDS = 30;
export const MAX_WAIT_SECONDS = 50;
/** How far back a wait looks without `since`: mail that came just before the call counts. */
export const LOOK_BACK_MS = 5 * 60 * 1000;
/** Pages of a mailbox one look reads at most, newest first, before giving up on older mail. */
const PAGES_PER_LOOK = 4;

/** What a wait asks for, as its input has it, parsed. */
export interface WaitInput {
	mailbox?: string | undefined;
	to?: string | undefined;
	from?: string | undefined;
	subject?: string | undefined;
	provedOnly?: boolean | undefined;
	since?: string | undefined;
	timeoutSeconds?: number | undefined;
}

/**
 * Looks at a mailbox until mail that matches has come, or the time is up: the newest match that
 * arrived since `since`. Each look asks as the agent, so a key revoked meanwhile ends the wait.
 */
export async function waitFor(
	access: MailAccess,
	input: WaitInput,
	signal: AbortSignal,
): Promise<{ box: AgentMailbox; found: ListedMessage | null }> {
	const wanted = input.mailbox ?? input.to;
	if (!wanted) throw new ApiError("Name the mailbox, or the address the mail comes to.", 400);
	const box = await findMailbox(access, wanted);
	const started = await access.startWait();
	if (!started.allowed) {
		throw new ApiError(
			"You have waited for mail many times in the last few minutes. Wait a few minutes, then try again.",
			429,
			started.retryAfter,
		);
	}
	const start = Date.now();
	const since = input.since ? Date.parse(input.since) : start - LOOK_BACK_MS;
	const deadline = start + (input.timeoutSeconds ?? WAIT_SECONDS) * 1000;
	let pause = 1000;
	for (;;) {
		const found = await newest(access, box.id, since, (message) => matches(message, input));
		const left = deadline - Date.now();
		if (found || left <= 0 || signal.aborted) return { box, found };
		await sleep(Math.min(pause, left), signal);
		pause = Math.min(pause * 1.5, MAX_PAUSE_MS);
	}
}

/** The newest message that matches, among those that arrived since then. */
async function newest(
	access: MailAccess,
	mailboxId: string,
	since: number,
	match: (message: ListedMessage) => boolean,
): Promise<ListedMessage | null> {
	let before: MessageCursor | null = null;
	for (let page = 0; page < PAGES_PER_LOOK; page++) {
		const listed: MailboxPage = gone(await access.messages(mailboxId, before));
		for (const message of listed.messages) {
			if (message.arrivedAt < since) return null;
			if (match(message)) return message;
		}
		if (!listed.next) return null;
		before = listed.next;
	}
	return null;
}

/** Whether mail that came in is what a wait asks for. */
function matches(message: ListedMessage, input: WaitInput): boolean {
	if (message.sent) return false;
	if (input.to && !message.cameTo.includes(input.to)) return false;
	if (input.subject && !message.subject.toLowerCase().includes(input.subject.toLowerCase())) {
		return false;
	}
	const address = message.from?.address.toLowerCase() ?? "";
	const fromDomain = domainOf(address);
	if (input.from) {
		const ok = input.from.includes("@")
			? address === input.from
			: fromDomain !== null && (fromDomain === input.from || fromDomain.endsWith(`.${input.from}`));
		if (!ok) return false;
	}
	// `verifiedDomain` is set only when it is the From's domain; asked again, as it is the proof.
	if (input.provedOnly && (!message.verifiedDomain || message.verifiedDomain !== fromDomain)) {
		return false;
	}
	return true;
}

/** An address's domain, when it is one: letters, digits, dashes and dots only. */
export function domainOf(address: string): string | null {
	const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
	return address.includes("@") && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain) ? domain : null;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		signal.addEventListener("abort", done, { once: true });
		function done() {
			clearTimeout(timer);
			signal.removeEventListener("abort", done);
			resolve();
		}
	});
}
