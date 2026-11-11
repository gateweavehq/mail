/** URL-safe base64, unpadded. */
export function toBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** Standard or URL-safe base64, padded or not; null when it is not base64. */
export function fromBase64(text: string): Uint8Array<ArrayBuffer> | null {
	const standard = text.trim().replaceAll("-", "+").replaceAll("_", "/").replace(/=+$/, "");
	if (!/^[A-Za-z0-9+/]*$/.test(standard)) return null;
	try {
		const binary = atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "="));
		return Uint8Array.from(binary, (char) => char.charCodeAt(0));
	} catch {
		return null;
	}
}
