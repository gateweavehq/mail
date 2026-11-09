import { describe, expect, it } from "vitest";
import { newSecret, SECRET_PREFIX, secretStart, sign, urlRefusal } from "./signing";

describe("sign", () => {
	it("signs as Standard Webhooks libraries check", async () => {
		// The example in Svix's documentation of the scheme, which Standard Webhooks took on.
		const signature = await sign(
			"whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw",
			"msg_p5jXN8AQM9LWM0D4loKWxJek",
			1614265330,
			'{"test": 2432232314}',
		);
		expect(signature).toBe("v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
	});

	it("makes a new secret of 24 random bytes each time, and shows only its start", () => {
		const one = newSecret();
		const two = newSecret();
		expect(one).not.toBe(two);
		expect(one.startsWith(SECRET_PREFIX)).toBe(true);
		expect(atob(one.slice(SECRET_PREFIX.length))).toHaveLength(24);
		expect(secretStart(one)).toBe(one.slice(0, SECRET_PREFIX.length + 4));
	});
});

describe("urlRefusal", () => {
	const app = "https://mail.example.com";

	it("takes an https URL elsewhere", () => {
		expect(urlRefusal("https://hooks.example.org/mail", app)).toBeNull();
	});

	it("takes plain http only where the app itself runs on it", () => {
		expect(urlRefusal("http://hooks.example.org/mail", app)).toBe("Use an https URL.");
		expect(urlRefusal("http://localhost:9000/mail", "http://localhost:4750")).toBeNull();
	});

	it("refuses Mail's own host, and a user name or password", () => {
		expect(urlRefusal("https://mail.example.com/api/v1/mailboxes", app)).toMatch(/Mail itself/);
		expect(urlRefusal("https://MAIL.example.com:443/", app)).toMatch(/Mail itself/);
		expect(urlRefusal("https://user:secret@hooks.example.org/", app)).toMatch(/user name/);
	});
});
