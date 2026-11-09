/**
 * A message a person writes, as Email Service is asked to send it and as the mailbox keeps a copy
 * of it. Email Service sets `Message-ID` itself and refuses one of ours, so Mail names the message
 * with an id of its own in `References`: a reply carries that id on in its own `References`, which
 * is how its thread finds it, whatever Email Service called the message.
 */

/** The most bytes Email Service takes in one header's value. */
export const MAX_HEADER_VALUE = 2_048;

/** A file a message carries. */
export interface OutgoingFile {
	filename: string;
	/** Its media type, lower case. */
	type: string;
	/** Its bytes in Base64, without line breaks. */
	content: string;
	/** For an image the HTML shows, the id its `cid:` names; null for a file attached. */
	contentId: string | null;
	/** How many bytes it holds. */
	bytes: number;
}

/** What the mailbox keeps of a file it sends, to find it in the copy again at each try. */
export type SentFile = Omit<OutgoingFile, "content">;

/** A message's files in the order its copy holds them: the inline images, then the rest. */
export function inCopyOrder<File extends SentFile>(files: File[]): File[] {
	return [
		...files.filter((file) => file.contentId !== null),
		...files.filter((file) => file.contentId === null),
	];
}

/**
 * The type a file has in the copy. A calendar's is read back as text, in Unicode and with new line
 * ends, so the copy keeps it as bytes, and each try gives it its own type again.
 */
export const copyType = (type: string) =>
	type === "text/calendar" || type === "application/ics" ? "application/octet-stream" : type;

/** What a person writes, with what threads it. */
export interface Outgoing {
	from: { name: string; email: string };
	to: string[];
	cc: string[];
	subject: string;
	text: string;
	/** Its HTML, beside the text, or null for text alone. */
	html: string | null;
	/** Its files, which go from the copy, not from `sendRequest`'s answer. */
	files: OutgoingFile[];
	/** The id of the message it answers, or null for a new one. */
	inReplyTo: string | null;
	/** The ids it follows, oldest first, ending with the one it answers. Mail's own id isn't here. */
	references: string[];
	/** Mail's id for it (`own-id.ts`), without angle brackets: its `Message-ID` in the copy. */
	ownId: string;
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

/**
 * What `send()` of the `EMAIL` binding is given, but for the files: the object reads those from the
 * copy at each try, so that their bytes are never in its own storage.
 */
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
		...(message.html === null ? {} : { html: message.html }),
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

/** A MIME part: its headers, and its body as it goes, without the line break that ends it. */
interface Part {
	headers: string[];
	body: string;
}

/** Base64 in lines of 76 characters, as MIME has it. */
const wrapped = (content: string) => content.match(/.{1,76}/g)?.join("\r\n") ?? "";

const textPart = (subtype: "plain" | "html", text: string): Part => ({
	headers: [`Content-Type: text/${subtype}; charset=utf-8`, "Content-Transfer-Encoding: base64"],
	body: wrapped(base64(new TextEncoder().encode(text.replace(/\r?\n/g, "\r\n")))),
});

/**
 * A parameter of a header, such as a file's name: quoted when it is short printable ASCII, and
 * otherwise as RFC 2231 writes it, in UTF-8, escaped and continued over lines that stay short.
 */
function parameter(key: string, value: string): string {
	const quoted = `${key}="${value.replace(/(["\\])/g, "\\$1")}"`;
	if (/^[\x20-\x7e]*$/.test(value) && quoted.length <= 70) return quoted;
	const escaped = encodeURIComponent(value).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	// Pieces of 50 characters at most, never splitting an escape.
	const pieces: string[] = [];
	let piece = "";
	for (const token of escaped.match(/%[0-9A-F]{2}|[^%]/g) ?? []) {
		if (piece.length + token.length > 50) {
			pieces.push(piece);
			piece = "";
		}
		piece += token;
	}
	pieces.push(piece);
	return pieces
		.map((each, at) => `${key}*${at}*=${at === 0 ? "UTF-8''" : ""}${each}`)
		.join(";\r\n ");
}

const filePart = (file: OutgoingFile): Part => ({
	headers: [
		`Content-Type: ${copyType(file.type)};\r\n ${parameter("name", file.filename)}`,
		`Content-Disposition: ${file.contentId === null ? "attachment" : "inline"};\r\n ${parameter("filename", file.filename)}`,
		...(file.contentId === null ? [] : [`Content-ID: <${file.contentId}>`]),
		"Content-Transfer-Encoding: base64",
	],
	body: wrapped(file.content),
});

/** Parts as one, under a boundary nothing in them can hold: Base64 has no `_`. */
function multipart(
	subtype: "alternative" | "related" | "mixed",
	parts: Part[],
	root: string | null = null,
): Part {
	const boundary = `=_${crypto.randomUUID()}`;
	const each = parts.map(
		(part) => `--${boundary}\r\n${part.headers.join("\r\n")}\r\n\r\n${part.body}\r\n`,
	);
	// RFC 2387 has `multipart/related` name the type of its first part.
	const type = root === null ? "" : `\r\n type="${root}";`;
	return {
		headers: [`Content-Type: multipart/${subtype};${type}\r\n boundary="${boundary}"`],
		body: `${each.join("")}--${boundary}--`,
	};
}

/**
 * A message's body as MIME: its text, beside its HTML when it has some, with the images that HTML
 * shows and then the files it carries.
 */
function bodyOf(message: Outgoing): Part {
	const text = textPart("plain", message.text);
	let body =
		message.html === null ? text : multipart("alternative", [text, textPart("html", message.html)]);
	const inline = message.files.filter((file) => file.contentId !== null);
	if (inline.length > 0) {
		const root = message.html === null ? "text/plain" : "multipart/alternative";
		body = multipart("related", [body, ...inline.map(filePart)], root);
	}
	const attached = message.files.filter((file) => file.contentId === null);
	if (attached.length > 0) body = multipart("mixed", [body, ...attached.map(filePart)]);
	return body;
}

/**
 * The copy the mailbox keeps of what it sent, as raw mail, so that reading it, downloading it and
 * searching it work as they do for mail that arrived. Its `Message-ID` is Mail's own id. It holds
 * the message whole, files too, and each try sends those from it.
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
	];
	const body = bodyOf(message);
	return `${[...lines, ...body.headers].join("\r\n")}\r\n\r\n${body.body}\r\n`;
}

function base64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
}
