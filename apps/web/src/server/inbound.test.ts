import { describe, expect, it } from "vitest";
import { NO_SUCH_ADDRESS, receiveMail } from "./inbound";

describe("receiveMail", () => {
	it("refuses with a permanent rejection, and does nothing else", async () => {
		const reasons: string[] = [];
		await receiveMail({ setReject: (reason) => reasons.push(reason) });
		expect(reasons).toEqual([NO_SUCH_ADDRESS]);
		expect(NO_SUCH_ADDRESS).toBe("No such address");
	});
});
