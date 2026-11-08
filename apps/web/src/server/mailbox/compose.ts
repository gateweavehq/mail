/**
 * A message a person writes, as Email Service is asked to send it and as the mailbox keeps a copy
 * of it. Email Service sets `Message-ID` itself and refuses one of ours, so Mail names the message
 * with an id of its own in `References`: a reply carries that id on in its own `References`, which
 * is how its thread finds it, whatever Email Service called the message.
 */

/** The most bytes Email Service takes in one header's value. */
export const MAX_HEADER_VALUE = 2_048;

/** What a person writes, with what threads it. */
export interface Outgoing {
	from: { name: string; email: string };
	to: string[];
	cc: string[];
	subject: string;
	text: string;
	/** The id of the message it answers, or null for a new one. */
	inReplyTo: string | null;
	/** The ids it follows, oldest first, ending with the one it answers. Mail's own id isn't here. */
	references: string[];
	/** Mail's id for it, without angle brackets: its `Message-ID` in the copy. */
	ownId: string;
}

/** A new id for a message the mailbox sends, on the domain it is sent from. */
export function newOwnId(fromEmail: string): string {
	const domain = fromEmail.slice(fromEmail.lastIndexOf("@") + 1);
	return `${crypto.randomUUID()}@${domain}`;
}

/**
 * The ids `References` names, which Email Service takes up to `MAX_HEADER_VALUE` bytes of. When
 * they don't all fit, the first and the newest stay, as RFC 5322 suggests, and Mail's own id, the
 * last, always does.
 */
export function referencesValue(references: string[], ownId: string): string {
	const own = `<${ownId}>`;
	const earlier = references.map((id) => `<${id}>`);
	const fits = (ids: string[]) =>
		new TextEncoder().encode(ids.join(" ")).length <= MAX_HEADER_VALUE;
	if (fits([...earlier, own])) return [...earlier, own].join(" ");
	const first = earlier[0];
	const head = first !== undefined && fits([first, own]) ? [first] : [];
	const newest: string[] = [];
	for (let i = earlier.length - 1; i >= head.length; i--) {
		const id = earlier[i];
		if (id === undefined || !fits([...head, id, ...newest, own])) break;
		newest.unshift(id);
	}
	return [...head, ...newest, own].join(" ");
}

/** A name for a header: control characters, line breaks among them, become spaces. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it removes.
export const plainName = (name: string) => name.replace(/[\x00-\x1f\x7f]+/g, " ").trim();

/** What `send()` of the `EMAIL` binding is given. */
export function sendRequest(message: Outgoing): EmailMessageBuilder {
	const headers: Record<string, string> = {
		References: referencesValue(message.references, message.ownId),
	};
	if (message.inReplyTo) headers["In-Reply-To"] = `<${message.inReplyTo}>`;
	return {
		from: { name: plainName(message.from.name), email: message.from.email },
		to: message.to,
		...(message.cc.length > 0 ? { cc: message.cc } : {}),
		subject: message.subject,
		text: message.text,
		headers,
	};
}

/** `Re:` before a subject, unless one is there already. */
export function replySubject(subject: string): string {
	return /^\s*re\s*:/i.test(subject) ? subject : `Re: ${subject}`;
}

/**
 * Text as a header may hold it: short ASCII as it is, anything else in RFC 2047's encoded words,
 * which keep each line short however long the text and whatever it holds.
 */
export function headerText(text: string): string {
	// No line breaks in a header, whatever was typed.
	const flat = text.replace(/[\r\n]+/g, " ");
	// With a header's name in front, such as "Subject: ", it fits in 78 characters.
	if (/^[\x20-\x7e]*$/.test(flat) && flat.length <= 66) return flat;
	return encodedWords(flat);
}

/**
 * Text in RFC 2047's encoded words, folded between them. Each holds at most 40 bytes, 56 characters
 * of Base64, and never splits a character, so a line with a header's name in front stays within
 * the 78 characters mail should keep to.
 */
function encodedWords(flat: string): string {
	const words: string[] = [];
	let bytes: number[] = [];
	const encoder = new TextEncoder();
	const flush = () => {
		if (bytes.length > 0) words.push(`=?UTF-8?B?${base64(new Uint8Array(bytes))}?=`);
		bytes = [];
	};
	for (const char of flat) {
		const encoded = encoder.encode(char);
		if (bytes.length + encoded.length > 40) flush();
		bytes.push(...encoded);
	}
	flush();
	return words.join("\r\n ");
}

/** A name and address as `From`, `To` and `Cc` write them. */
export function addressHeader(person: { name: string; email: string }): string {
	const name = plainName(person.name);
	if (!name) return person.email;
	if (/^[\x20-\x7e]*$/.test(name)) {
		// A name with a comma, a dot or the like would be read as more than one address unless quoted.
		const plain = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~ ]+$/.test(name);
		const shown = plain ? name : `"${name.replace(/(["\\])/g, "\\$1")}"`;
		if (shown.length <= 40) return `${shown} <${person.email}>`;
		// A longer one has the address on a line of its own.
		if (shown.length <= 66) return `${shown}\r\n <${person.email}>`;
	}
	// Encoded words need no quoting: what is in them is never read as an address.
	return `${encodedWords(name)}\r\n <${person.email}>`;
}

/** A date as RFC 5322 writes it, in UTC. */
export function dateHeader(date: Date): string {
	return date.toUTCString().replace(/GMT$/, "+0000");
}

/**
 * The copy the mailbox keeps of what it sent, as raw mail, so that reading it, downloading it and
 * searching it work as they do for mail that arrived. Its `Message-ID` is Mail's own id.
 */
export function rawCopy(message: Outgoing, date: Date): string {
	const lines = [
		`From: ${addressHeader(message.from)}`,
		`To: ${message.to.join(",\r\n ")}`,
		...(message.cc.length > 0 ? [`Cc: ${message.cc.join(",\r\n ")}`] : []),
		`Subject: ${headerText(message.subject)}`,
		`Date: ${dateHeader(date)}`,
		`Message-ID: <${message.ownId}>`,
		...(message.inReplyTo ? [`In-Reply-To: <${message.inReplyTo}>`] : []),
		// Folded between ids, so no line runs past what mail allows.
		`References: ${referencesValue(message.references, message.ownId).split(" ").join("\r\n ")}`,
		"MIME-Version: 1.0",
		"Content-Type: text/plain; charset=utf-8",
		"Content-Transfer-Encoding: base64",
	];
	const body = base64(new TextEncoder().encode(message.text.replace(/\r?\n/g, "\r\n")));
	const wrapped = body.match(/.{1,76}/g)?.join("\r\n") ?? "";
	return `${lines.join("\r\n")}\r\n\r\n${wrapped}\r\n`;
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
