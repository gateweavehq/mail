// Gateweave Mail's agent API for TypeScript and JavaScript: a client with a method for each
// route, the routes' types, made from the API's OpenAPI document, and a check of the signature on
// a webhook delivery. It runs wherever fetch and Web Crypto do: browsers, Workers and Node.

export * from "./api.gen.js";
export {
	type Fetch,
	type Issue,
	MailClient,
	type MailClientOptions,
	MailError,
} from "./client.js";
export { VERSION } from "./version.js";
export {
	type VerifyWebhookOptions,
	verifyWebhook,
	WebhookError,
	type WebhookEvent,
	type WebhookHeaders,
} from "./webhooks.js";
