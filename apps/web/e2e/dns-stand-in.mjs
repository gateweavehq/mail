// Stands in for a DNS-over-HTTPS resolver, so the browser tests can prove a domain without one.
// `POST /records` with `{ domain, txt, mx }` sets what a domain has, as if its owner had changed its
// DNS. Everything else has no records, which is how a real resolver answers a name it doesn't know.
import { createServer } from "node:http";

export function startDnsStandIn(port) {
	const zones = new Map();
	const server = createServer(async (request, response) => {
		const url = new URL(request.url ?? "/", "http://localhost");
		if (request.method === "POST" && url.pathname === "/records") {
			let body = "";
			for await (const chunk of request) body += chunk;
			const { domain, txt = [], mx = [] } = JSON.parse(body);
			zones.set(`_gateweave-mail.${domain}|TXT`, txt);
			zones.set(`${domain}|MX`, mx);
			response.writeHead(204).end();
			return;
		}
		const name = url.searchParams.get("name") ?? "";
		const type = url.searchParams.get("type") ?? "";
		const records = zones.get(`${name}|${type}`) ?? [];
		response.writeHead(200, { "content-type": "application/dns-json" }).end(
			JSON.stringify({
				Status: 0,
				Answer: records.map((record) =>
					type === "TXT"
						? { name, type: 16, data: `"${record}"` }
						: { name, type: 15, data: `10 ${record}.` },
				),
			}),
		);
	});
	server.listen(port);
	return server;
}
