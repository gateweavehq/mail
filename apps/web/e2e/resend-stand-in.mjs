// Stands in for Resend's API, so the browser tests can send through Resend without an account.
// It takes any key that starts with "re_e2e", as one that may only send, as a key made for one
// domain would. `GET /sent` lists what it sent, newest last, for the tests to look at.
import { createServer } from "node:http";

export function startResendStandIn(port) {
	const sent = [];
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		const answer = (status, body) =>
			response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));
		if (request.method === "GET" && url.pathname === "/sent") return answer(200, sent);
		const key = (request.headers.authorization ?? "").replace(/^Bearer /, "");
		if (!/^re_e2e\w+$/.test(key)) {
			return answer(401, { name: "validation_error", message: "API key is invalid" });
		}
		if (request.method === "GET" && url.pathname === "/domains") {
			return answer(401, {
				name: "restricted_api_key",
				message: "This API key is restricted to only send emails",
			});
		}
		if (request.method === "POST" && url.pathname === "/emails") {
			let body = "";
			for await (const chunk of request) body += chunk;
			const id = crypto.randomUUID();
			sent.push({ id, idempotencyKey: request.headers["idempotency-key"], ...JSON.parse(body) });
			return answer(200, { id });
		}
		return answer(404, { name: "not_found" });
	});
	server.listen(port);
	return server;
}
