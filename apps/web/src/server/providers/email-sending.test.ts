import { describe, expect, it } from "vitest";
import { emailSendingApi } from "./email-sending";

describe("the deployment's access to Email Service's list", () => {
	const accountId = "0123456789abcdef0123456789abcdef";

	it("needs an account id and a token", () => {
		expect(
			emailSendingApi({ EMAIL_SENDING_ACCOUNT_ID: accountId, EMAIL_SENDING_API_TOKEN: " t " }),
		).toEqual({ accountId, token: "t" });
		expect(emailSendingApi({ EMAIL_SENDING_ACCOUNT_ID: accountId })).toBeNull();
		expect(emailSendingApi({ EMAIL_SENDING_API_TOKEN: "t" })).toBeNull();
		expect(
			emailSendingApi({ EMAIL_SENDING_ACCOUNT_ID: accountId, EMAIL_SENDING_API_TOKEN: " " }),
		).toBeNull();
	});

	it("takes only what can be an account id, as it goes into the API's path", () => {
		const upper = {
			EMAIL_SENDING_ACCOUNT_ID: accountId.toUpperCase(),
			EMAIL_SENDING_API_TOKEN: "t",
		};
		expect(emailSendingApi(upper)?.accountId).toBe(accountId);
		for (const id of ["../zones", `${accountId}/x`, accountId.slice(1)]) {
			expect(
				emailSendingApi({ EMAIL_SENDING_ACCOUNT_ID: id, EMAIL_SENDING_API_TOKEN: "t" }),
			).toBeNull();
		}
	});
});
