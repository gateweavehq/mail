import { describe, expect, it } from "vitest";
import { isSigningSecret, SVIX_TOLERANCE_MS, verifySvix } from "./svix";

// Svix's own example, from https://docs.svix.com/receiving/verifying-payloads/how-manual.
const SECRET = "whsec_plJ3nmyCDGBKInavdOK15jsl";
const BODY = '{"event_type":"ping","data":{"success":true}}';
const ID = "msg_loFOjxBNrRLzqYUf";
const TIMESTAMP = "1731705121";
const SIGNATURE = "v1,rAvfW3dJ/X/qxhsaXPOyyCGmRKsaKWcsNccKXlIktD0=";
const AT = Number(TIMESTAMP) * 1000;

const headers = (signature = SIGNATURE, timestamp = TIMESTAMP, id = ID) => ({
	id,
	timestamp,
	signature,
});

describe("verifySvix", () => {
	it("takes Svix's own example", async () => {
		expect(await verifySvix(SECRET, headers(), BODY, AT)).toBe(true);
	});

	it("finds the right signature among several, as while a secret is rolled", async () => {
		const several = `v1,${btoa("x".repeat(32))} v2,abc ${SIGNATURE}`;
		expect(await verifySvix(SECRET, headers(several), BODY, AT)).toBe(true);
	});

	it("refuses a body, id or timestamp that was changed", async () => {
		expect(await verifySvix(SECRET, headers(), BODY.replace("true", "false"), AT)).toBe(false);
		expect(await verifySvix(SECRET, headers(SIGNATURE, TIMESTAMP, "msg_other"), BODY, AT)).toBe(
			false,
		);
		expect(await verifySvix(SECRET, headers(SIGNATURE, "1731705122"), BODY, AT)).toBe(false);
	});

	it("refuses another secret", async () => {
		expect(await verifySvix("whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw", headers(), BODY, AT)).toBe(
			false,
		);
	});

	it("refuses a delivery from too long ago or too far ahead", async () => {
		expect(await verifySvix(SECRET, headers(), BODY, AT + SVIX_TOLERANCE_MS)).toBe(true);
		expect(await verifySvix(SECRET, headers(), BODY, AT + SVIX_TOLERANCE_MS + 1_000)).toBe(false);
		expect(await verifySvix(SECRET, headers(), BODY, AT - SVIX_TOLERANCE_MS - 1_000)).toBe(false);
	});

	it("refuses what is missing or malformed", async () => {
		expect(await verifySvix(SECRET, { ...headers(), id: null }, BODY, AT)).toBe(false);
		expect(await verifySvix(SECRET, { ...headers(), signature: null }, BODY, AT)).toBe(false);
		expect(await verifySvix(SECRET, headers(SIGNATURE, "17317e5121"), BODY, AT)).toBe(false);
		expect(await verifySvix(SECRET, headers("v1,%%%"), BODY, AT)).toBe(false);
		expect(await verifySvix(SECRET, headers(SIGNATURE.replace("v1,", "v2,")), BODY, AT)).toBe(
			false,
		);
		expect(await verifySvix("plJ3nmyCDGBKInavdOK15jsl", headers(), BODY, AT)).toBe(false);
	});
});

describe("isSigningSecret", () => {
	it("knows a secret from something else", () => {
		expect(isSigningSecret(SECRET)).toBe(true);
		expect(isSigningSecret("whsec_")).toBe(false);
		expect(isSigningSecret("whsec_***")).toBe(false);
		expect(isSigningSecret("re_123456789")).toBe(false);
	});
});
