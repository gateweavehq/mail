/** Files a message carries, checked as a request to send gives them. */
import { fileNameRefusal, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENTS } from "../../lib/outbox";
import type { OutgoingFile } from "./compose";

/** A file as a request to send gives it. */
export interface GivenFile {
	filename: string;
	contentType?: string | null | undefined;
	/** Its bytes in Base64; line breaks and spaces are dropped. */
	content: string;
	/** For an image the HTML shows: the id its `cid:` names. */
	contentId?: string | null | undefined;
}

/** Media types by a name's extension, for a file given without one. */
const TYPES: Record<string, string> = {
	pdf: "application/pdf",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
	svg: "image/svg+xml",
	txt: "text/plain",
	csv: "text/csv",
	md: "text/markdown",
	html: "text/html",
	htm: "text/html",
	ics: "text/calendar",
	json: "application/json",
	xml: "application/xml",
	zip: "application/zip",
	gz: "application/gzip",
	doc: "application/msword",
	docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
	xls: "application/vnd.ms-excel",
	xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
	ppt: "application/vnd.ms-powerpoint",
	pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
	odt: "application/vnd.oasis.opendocument.text",
	ods: "application/vnd.oasis.opendocument.spreadsheet",
	mp3: "audio/mpeg",
	wav: "audio/wav",
	mp4: "video/mp4",
};

/** A media type as RFC 6838 names one, lower case. */
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]{0,62}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,62}$/;

/** A `Content-ID` without its angle brackets: RFC 5322's atoms, dots and an @, nothing else. */
const CONTENT_ID = /^[A-Za-z0-9!#$%&'*+\-/=?^_`{|}~.@]{1,100}$/;

/** The type a file of this name has, as far as its extension says. */
export function typeOfName(name: string): string {
	const extension = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
	return TYPES[extension] ?? "application/octet-stream";
}

/** How many bytes this Base64 holds, or null when it isn't Base64. */
export function base64Size(content: string): number | null {
	if (content.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(content)) return null;
	const padding = content.endsWith("==") ? 2 : content.endsWith("=") ? 1 : 0;
	return (content.length / 4) * 3 - padding;
}

export type FilesChecked =
	| { ok: true; files: OutgoingFile[]; bytes: number }
	| { ok: false; error: string };

/**
 * The files of a message, or why they can't go: too many or too large together, a name or kind
 * Mail doesn't send, content that isn't Base64, or two inline images with one id. Only the Base64 is
 * read, never decoded, so a large file isn't held twice.
 */
export function checkFiles(given: GivenFile[]): FilesChecked {
	if (given.length > MAX_ATTACHMENTS) {
		return { ok: false, error: `A message carries ${MAX_ATTACHMENTS} files at most.` };
	}
	const files: OutgoingFile[] = [];
	const ids = new Set<string>();
	let bytes = 0;
	for (const file of given) {
		const filename = file.filename.trim();
		const refusal = fileNameRefusal(filename);
		if (refusal) return { ok: false, error: refusal };
		const content = file.content.replace(/\s+/g, "");
		const size = base64Size(content);
		if (size === null) return { ok: false, error: `The content of ${filename} isn't Base64.` };
		if (size === 0) return { ok: false, error: `${filename} is empty.` };
		bytes += size;
		if (bytes > MAX_ATTACHMENT_BYTES) {
			return { ok: false, error: "A message's files can hold 10 MB together at most." };
		}
		const type = file.contentType?.trim().toLowerCase() || typeOfName(filename);
		// Those two may not be sent in Base64, which is how every file goes.
		if (!MEDIA_TYPE.test(type) || /^(multipart|message)\//.test(type)) {
			return { ok: false, error: `${filename} needs a media type such as application/pdf.` };
		}
		const contentId = file.contentId?.trim() || null;
		if (contentId !== null) {
			if (!CONTENT_ID.test(contentId)) {
				return {
					ok: false,
					error: `The content id of ${filename} takes letters, digits and . @ - _ only.`,
				};
			}
			if (ids.has(contentId.toLowerCase())) {
				return { ok: false, error: `Two files have the content id ${contentId}.` };
			}
			ids.add(contentId.toLowerCase());
		}
		files.push({ filename, type, content, contentId });
	}
	return { ok: true, files, bytes };
}
