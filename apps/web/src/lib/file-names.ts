// The name a file someone sent goes by, where Mail shows it and where it is saved. No server code:
// the message's page shows the name a download will have, so that the two never differ.

import { MAX_FILE_NAME } from "./outbox";

/** What a file is called when its sender named it nothing a system could save. */
export const UNNAMED_FILE = "attachment";

/**
 * Marks that only change which way text runs, and invisible characters. Taken out of a name, as
 * `invoice[RLO]fdp.exe` would show as a PDF.
 */
const INVISIBLE = /[\p{Bidi_Control}​-‍⁠﻿]/gu;

/** A control character, or one a system's file names can't hold, or that reads as a folder. */
function unsafe(char: string): boolean {
	const code = char.codePointAt(0) ?? 0;
	return code < 0x20 || (code >= 0x7f && code <= 0x9f) || '/\\<>:"|?*'.includes(char);
}

/**
 * The name a file is saved under, and shown by: its sender's, without what would make it a path, a
 * hidden file or a control, nor the marks that turn text around.
 */
export function fileName(name: string | null): string {
	// By code point, so a character outside the first plane isn't cut in two.
	const cleaned = Array.from((name ?? "").normalize("NFC").replace(INVISIBLE, ""), (char) =>
		unsafe(char) ? "_" : char,
	)
		.join("")
		// Spaces and dots together, so that ". .env" doesn't come out hidden either.
		.replace(/^[\s.]+/u, "")
		.trimEnd();
	return Array.from(cleaned).slice(0, MAX_FILE_NAME).join("").trimEnd() || UNNAMED_FILE;
}
