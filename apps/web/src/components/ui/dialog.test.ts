import { describe, expect, it } from "vitest";
import { cn } from "#/lib/utils";
import { DIALOG_CONTENT_CLASS } from "./dialog";

describe("A dialog's box", () => {
	// The trigger dialog came to 1,012 pixels in an 883-pixel window: centred, its title and its
	// Save button were out of reach, and nothing scrolled.
	it("is never taller than the window, and scrolls within itself", () => {
		const classes = DIALOG_CONTENT_CLASS.split(" ");
		expect(classes).toContain("max-h-[calc(100dvh-2rem)]");
		expect(classes).toContain("overflow-y-auto");
	});

	it("keeps both when a dialog sets its own width", () => {
		const classes = cn(DIALOG_CONTENT_CLASS, "max-w-md").split(" ");
		expect(classes).toEqual(
			expect.arrayContaining(["max-h-[calc(100dvh-2rem)]", "overflow-y-auto", "max-w-md"]),
		);
		expect(classes).not.toContain("max-w-lg");
	});
});
