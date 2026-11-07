import { afterAll, beforeAll, expect, it } from "vitest";
import { startMail } from "./mail-worker";

// workerd forbids I/O in global scope. Better Auth starts resolving its context as soon as it is
// created, so building it at module load can log an error on every cold start that hides real
// ones. The app builds it on first use instead.

const origin = "https://mail.test";

let mail: Awaited<ReturnType<typeof startMail>>;

beforeAll(async () => {
	mail = await startMail(origin);
});

afterAll(async () => {
	await mail?.dispose();
});

it("starts and serves requests without logging an error", async () => {
	await mail.fetch(`${origin}/login`);
	const session = await mail.fetch(`${origin}/api/auth/get-session`, { headers: { origin } });
	expect(session.status).toBe(200);

	expect(mail.logs.filter((log) => log.level === "error")).toEqual([]);
});
