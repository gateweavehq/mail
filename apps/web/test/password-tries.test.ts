import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startMail } from "./mail-worker";

// What someone holding a session can try at a password, through the public routes of the built
// Worker. A stolen cookie can be sent from many addresses, so every request here comes from one of
// its own, which keeps Better Auth's limit per address out of it.

const origin = "https://mail.test";
const PASSWORD = "a-long-test-password";
const WRONG = "not-the-password";

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin);
});

afterAll(async () => {
	await mail?.dispose();
});

let clients = 0;

function newClient() {
	clients += 1;
	return `198.51.${Math.floor(clients / 250)}.${(clients % 250) + 1}`;
}

function api(path: string, init: { cookie?: string; body?: object }) {
	const { cookie, body } = init;
	return mail.fetch(`${origin}/api/auth${path}`, {
		method: body ? "POST" : "GET",
		headers: {
			origin,
			"cf-connecting-ip": newClient(),
			...(body && { "content-type": "application/json" }),
			...(cookie && { cookie }),
		},
		body: body && JSON.stringify(body),
	});
}

function cookieOf(response: Response): string {
	return response.headers
		.getSetCookie()
		.map((cookie) => cookie.split(";")[0] ?? "")
		.filter((cookie) => !cookie.endsWith("="))
		.join("; ");
}

let people = 0;

/** A new person with a password, signed in on one device. */
async function newPerson() {
	const email = `guessed-at-${++people}@tries.test`;
	const entered = await api("/sign-up/email", {
		body: { name: "Ada", email, password: PASSWORD },
	});
	expect(entered.status).toBe(200);
	return { email, cookie: cookieOf(entered) };
}

type Person = Awaited<ReturnType<typeof newPerson>>;

type Asking = [path: string, body: (password: string) => object];

const changing: Asking = [
	"/change-password",
	(password) => ({ currentPassword: password, newPassword: "another-long-password" }),
];

/** Every path where a session shows a password, and how each asks for it. */
const ASKING: Asking[] = [changing, ["/account/delete", (password) => ({ password })]];

function tryAt([path, body]: Asking, person: Person, password = WRONG): Promise<Response> {
	return api(path, { cookie: person.cookie, body: body(password) });
}

describe("the allowance per person", () => {
	it("is ten tries, from however many addresses", async () => {
		const person = await newPerson();
		for (let tries = 0; tries < 10; tries++) {
			expect((await tryAt(changing, person)).status).toBe(400);
		}
		const refused = await tryAt(changing, person);
		expect(refused.status).toBe(429);
		expect(((await refused.json()) as { code?: string }).code).toBe("TOO_MANY_PASSWORD_TRIES");
	});

	it("refuses the right password too once it is spent, which proves nothing to a guesser", async () => {
		const person = await newPerson();
		for (let tries = 0; tries < 10; tries++) await tryAt(changing, person);
		expect((await tryAt(changing, person, PASSWORD)).status).toBe(429);
		// It was not changed, whatever the answer says.
		const signedIn = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(signedIn.status).toBe(200);
	});

	it.each(ASKING)("is spent by %s, and refused there", async (...asking) => {
		const person = await newPerson();
		for (let tries = 0; tries < 10; tries++) {
			expect((await tryAt(asking, person)).status).toBe(400);
		}
		expect((await tryAt(asking, person)).status).toBe(429);
		expect((await tryAt(changing, person)).status).toBe(429);
	});

	it("is the same one on every device of that person's", async () => {
		const person = await newPerson();
		const another = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(another.status).toBe(200);
		const device = { ...person, cookie: cookieOf(another) };
		for (let tries = 0; tries < 5; tries++) {
			expect((await tryAt(changing, person)).status).toBe(400);
			expect((await tryAt(changing, device)).status).toBe(400);
		}
		expect((await tryAt(changing, person)).status).toBe(429);
		expect((await tryAt(changing, device)).status).toBe(429);
	});

	it("is not spent by a request with no password to check", async () => {
		const person = await newPerson();
		for (let tries = 0; tries < 11; tries++) {
			const nothing = await api("/account/delete", { cookie: person.cookie, body: {} });
			expect(nothing.status).toBe(400);
		}
		expect((await tryAt(changing, person)).status).toBe(400);
	});
});

// The cap must not become a way to lock someone out.
describe("who cannot spend someone's allowance", () => {
	it("anyone with only their address, signing in or not", async () => {
		const person = await newPerson();
		for (let tries = 0; tries < 11; tries++) {
			const signingIn = await api("/sign-in/email", {
				body: { email: person.email, password: WRONG },
			});
			expect(signingIn.status).toBe(401);
			const noSession = await api("/change-password", {
				body: { currentPassword: WRONG, newPassword: "another-long-password" },
			});
			expect(noSession.status).toBe(401);
		}
		for (let tries = 0; tries < 10; tries++) {
			expect((await tryAt(changing, person)).status).toBe(400);
		}
	});

	it("someone with a session of their own", async () => {
		const person = await newPerson();
		const stranger = await newPerson();
		for (let tries = 0; tries < 10; tries++) await tryAt(changing, stranger);
		expect((await tryAt(changing, stranger)).status).toBe(429);
		expect((await tryAt(changing, person)).status).toBe(400);
	});
});

describe("telling the person it has run out", () => {
	const SUBJECT = "Too many tries at your Gateweave Mail password";

	const told = async (email: string) =>
		(await mail.emails()).filter((each) => each.to === email && each.subject === SUBJECT);

	/** Email goes out after the response, so wait for it to arrive. */
	async function untilTold(email: string) {
		for (let attempt = 0; attempt < 100; attempt++) {
			const emails = await told(email);
			if (emails.length > 0) return emails;
			await new Promise((resolve) => setTimeout(resolve, 50));
		}
		throw new Error(`No email to ${email} about "${SUBJECT}"`);
	}

	/** Long enough for an email that should not go out to have gone. */
	const afterTheBackgroundWork = () => new Promise((resolve) => setTimeout(resolve, 500));

	async function verify({ email }: Person) {
		await mail.db.prepare("UPDATE user SET email_verified = 1 WHERE email = ?").bind(email).run();
	}

	async function spendAll(person: Person) {
		for (let tries = 0; tries < 10; tries++) {
			expect((await tryAt(changing, person)).status).toBe(400);
		}
	}

	it("emails them at the first refusal and not before, saying what to do", async () => {
		const person = await newPerson();
		await verify(person);
		await spendAll(person);
		await afterTheBackgroundWork();
		expect(await told(person.email)).toEqual([]);

		expect((await tryAt(changing, person)).status).toBe(429);
		const [email] = await untilTold(person.email);
		expect(email?.text).toContain(person.email);
		expect(email?.text).toContain("Sign out everywhere");
	});

	it("emails them once, however long it goes on", async () => {
		const person = await newPerson();
		await verify(person);
		await spendAll(person);
		for (let tries = 0; tries < 3; tries++) {
			expect((await tryAt(changing, person)).status).toBe(429);
		}
		await untilTold(person.email);
		await afterTheBackgroundWork();
		expect(await told(person.email)).toHaveLength(1);
	});

	// Anyone can sign up with a stranger's address, and would otherwise have this sent there.
	it("says nothing to an address they have not shown is theirs, and keeps the email for when they do", async () => {
		const person = await newPerson();
		await spendAll(person);
		expect((await tryAt(changing, person)).status).toBe(429);
		await afterTheBackgroundWork();
		expect(await told(person.email)).toEqual([]);

		await verify(person);
		expect((await tryAt(changing, person)).status).toBe(429);
		await untilTold(person.email);
	});

	it("refuses just the same on a server with no email", async () => {
		const noEmail = await startMail(origin, { settings: { EMAIL_FROM: "" } });
		try {
			const answer = (path: string, cookie: string | undefined, body: object) =>
				noEmail.fetch(`${origin}/api/auth${path}`, {
					method: "POST",
					headers: {
						origin,
						"cf-connecting-ip": newClient(),
						"content-type": "application/json",
						...(cookie && { cookie }),
					},
					body: JSON.stringify(body),
				});
			const entered = await answer("/sign-up/email", undefined, {
				name: "Ada",
				email: "no-email@tries.test",
				password: PASSWORD,
			});
			expect(entered.status).toBe(200);
			const cookie = cookieOf(entered);
			await noEmail.db
				.prepare("UPDATE user SET email_verified = 1 WHERE email = ?")
				.bind("no-email@tries.test")
				.run();
			const [path, body] = changing;
			for (let tries = 0; tries < 10; tries++) {
				expect((await answer(path, cookie, body(WRONG))).status).toBe(400);
			}
			expect((await answer(path, cookie, body(WRONG))).status).toBe(429);
			await afterTheBackgroundWork();
			expect(await noEmail.emails()).toEqual([]);
		} finally {
			await noEmail.dispose();
		}
	});
});

describe("once it is spent", () => {
	it("still lets the person end every session, and sign in again", async () => {
		const person = await newPerson();
		const signedIn = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(signedIn.status).toBe(200);
		const thief = { ...person, cookie: cookieOf(signedIn) };
		for (let tries = 0; tries < 11; tries++) await tryAt(changing, thief);
		expect((await tryAt(changing, thief)).status).toBe(429);

		const out = await api("/revoke-sessions", { cookie: person.cookie, body: {} });
		expect(out.status).toBe(200);
		for (const cookie of [thief.cookie, person.cookie]) {
			const session = await api("/get-session", { cookie });
			expect(await session.json()).toBeNull();
		}
		const again = await api("/sign-in/email", {
			body: { email: person.email, password: PASSWORD },
		});
		expect(again.status).toBe(200);
	});
});
