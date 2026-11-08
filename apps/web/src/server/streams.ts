/** What `readUpTo` read: the pieces as the stream gave them, and how many bytes they hold. */
export interface Read {
	chunks: Uint8Array[];
	size: number;
}

/**
 * Reads a whole stream, or stops and gives null once it has given more than `limit` bytes. The
 * pieces aren't joined, so a large body isn't held twice.
 */
export async function readUpTo(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
): Promise<Read | null> {
	const read: Read = { chunks: [], size: 0 };
	if (!body) return read;
	const reader = body.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return read;
		read.size += value.byteLength;
		if (read.size > limit) {
			await reader.cancel();
			return null;
		}
		read.chunks.push(value);
	}
}

/** The bytes `readUpTo` read, as text. */
export function textOf(read: Read): string {
	const decoder = new TextDecoder();
	let text = "";
	for (const chunk of read.chunks) text += decoder.decode(chunk, { stream: true });
	return text + decoder.decode();
}

/** The bytes `readUpTo` read, as a stream again, giving each piece up once it is taken. */
export function streamOf(read: Read): ReadableStream<Uint8Array> {
	const chunks = read.chunks;
	read.chunks = [];
	let at = 0;
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			const chunk = chunks[at];
			if (chunk === undefined) {
				controller.close();
				return;
			}
			chunks[at++] = new Uint8Array();
			controller.enqueue(chunk);
		},
	});
}
