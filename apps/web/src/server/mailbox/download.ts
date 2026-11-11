// How a file someone sent goes to a browser: always as a download, under the name its sender gave
// it, and never as anything a browser would show or run on Mail's origin. A sender chooses a file's
// bytes, its name and its stated type, so none of them is trusted.

import { fileName } from "../../lib/file-names";

/**
 * Stated types a file keeps, so that the system it is saved on opens it with the right program:
 * types no browser runs. Anything else, HTML, SVG, XML or a script among them, goes as bytes.
 */
const KEPT =
	/^(?:image\/(?:png|jpeg|gif|webp|avif|bmp|heic|heif|tiff)|application\/pdf|text\/(?:plain|csv|calendar)|audio\/[\w.+-]+|video\/[\w.+-]+|application\/(?:zip|gzip|x-7z-compressed|x-tar|rtf|msword|vnd\.ms-excel|vnd\.ms-powerpoint|vnd\.openxmlformats-officedocument\.[\w.+-]+|vnd\.oasis\.opendocument\.[\w.+-]+))$/;

/** The type a file goes with: its own, when it is one no browser runs, or plain bytes. */
export function downloadType(stated: string): string {
	const type = stated.split(";")[0]?.trim().toLowerCase() ?? "";
	return KEPT.test(type) ? type : "application/octet-stream";
}

/**
 * `Content-Disposition` for a download named `name`, as RFC 6266 has it: the name in UTF-8 for
 * every browser of today, and in ASCII, with `_` for anything else, for any that isn't.
 */
export function contentDisposition(name: string): string {
	const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\%]/g, "_");
	// RFC 8187's attr-char leaves out what encodeURIComponent keeps of these.
	const encoded = encodeURIComponent(name).replace(
		/['()*]/g,
		(char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
	);
	return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

/** A file as one of a message's attachments has it. */
export interface SentFile {
	name: string | null;
	type: string;
	bytes: Uint8Array<ArrayBuffer>;
}

/**
 * A file a message carries, as a download. Its own policy sandboxes it, so that even a browser that
 * showed it would run nothing of it, and with the origin's other headers (`nosniff` among them)
 * nothing guesses it is something else.
 */
export function fileDownload(file: SentFile): Response {
	return new Response(file.bytes, {
		headers: {
			"content-type": downloadType(file.type),
			"content-length": String(file.bytes.byteLength),
			"content-disposition": contentDisposition(fileName(file.name)),
			"content-security-policy": "default-src 'none'; sandbox",
			"x-content-type-options": "nosniff",
			"cache-control": "private, no-store",
			// The address names the workspace, the mailbox and the message.
			"referrer-policy": "no-referrer",
			"cross-origin-resource-policy": "same-origin",
		},
	});
}
