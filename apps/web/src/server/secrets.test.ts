import { describe, expect, it } from "vitest";
import { isSealer, type Sealer, sealerFor } from "./secrets";

const KEY = Buffer.alloc(32, 7).toString("base64");

async function sealer(scope: string, key = KEY): Promise<Sealer> {
	const made = await sealerFor(key, scope);
	if (!isSealer(made)) throw new Error(made.unavailable);
	return made;
}

describe("sealerFor", () => {
	it("opens what it sealed, and the sealed value doesn't hold the secret", async () => {
		const workspace = await sealer("workspace-1");
		const sealed = await workspace.seal("provider-keys/resend", "re_secret_value");
		expect(sealed).toMatch(/^v1\./);
		expect(sealed).not.toContain("re_secret_value");
		expect(await workspace.open("provider-keys/resend", sealed)).toBe("re_secret_value");
	});

	it("doesn't open another workspace's value, or one moved to another place", async () => {
		const sealed = await (await sealer("workspace-1")).seal("provider-keys/resend", "re_x");
		await expect(
			(await sealer("workspace-2")).open("provider-keys/resend", sealed),
		).rejects.toThrow("A secret could not be opened");
		await expect((await sealer("workspace-1")).open("provider-keys/other", sealed)).rejects.toThrow(
			"A secret could not be opened",
		);
	});

	it("doesn't open a value under another SECRETS_KEY", async () => {
		const sealed = await (await sealer("workspace-1")).seal("provider-keys/resend", "re_x");
		const other = await sealer("workspace-1", Buffer.alloc(32, 8).toString("base64"));
		await expect(other.open("provider-keys/resend", sealed)).rejects.toThrow();
	});

	it("says why it can't keep secrets without a key long enough", async () => {
		expect(await sealerFor(undefined, "w")).toEqual({
			unavailable: expect.stringContaining("SECRETS_KEY"),
		});
		expect(await sealerFor(Buffer.alloc(16).toString("base64"), "w")).toEqual({
			unavailable: expect.stringContaining("32 bytes"),
		});
		expect(await sealerFor("not base64!", "w")).toEqual({
			unavailable: expect.stringContaining("SECRETS_KEY"),
		});
	});
});
