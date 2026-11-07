// Entry point for `pnpm auth:schema` only. The Better Auth CLI reads the configuration to
// generate the Drizzle schema; it never connects to a database.
import { createDb } from "../db";
import { createAuth } from "./config";

export const auth = createAuth({
	db: createDb({} as D1Database),
	secret: "schema-generation-only",
	baseURL: "http://localhost:4750",
});
