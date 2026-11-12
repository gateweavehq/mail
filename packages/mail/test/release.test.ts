import { describe, expect, it } from "vitest";
import {
	checkPackage,
	compareVersions,
	readTar,
	releaseKeys,
	sha256sums,
} from "../scripts/release.mjs";

/** A ustar header for a file of this name and size, with a pax header first for a long name. */
function tar(entries: [name: string, body: string][]): Uint8Array {
	const blocks: Buffer[] = [];
	const header = (name: string, size: number, type: string) => {
		const block = Buffer.alloc(512);
		block.write(name.slice(0, 100), 0);
		block.write("0000644\0", 100);
		block.write(`${size.toString(8).padStart(11, "0")}\0`, 124);
		block.write(type, 156);
		block.write("ustar\u000000", 257);
		return block;
	};
	const pad = (body: Buffer) =>
		Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
	for (const [name, text] of entries) {
		const body = Buffer.from(text);
		if (name.length > 100) {
			const record = ` path=${name}\n`;
			const pax = Buffer.from(`${record.length + String(record.length).length}${record}`);
			blocks.push(header("PaxHeader", pax.length, "x"), pad(pax));
		}
		blocks.push(header(name, body.length, "0"), pad(body));
	}
	blocks.push(Buffer.alloc(1024));
	return Buffer.concat(blocks);
}

const AGPL = "                    GNU AFFERO GENERAL PUBLIC LICENSE\n";

function packed(changes: Record<string, string | undefined> = {}) {
	const manifest = {
		name: "@gateweave/mail",
		version: "1.2.3",
		license: "AGPL-3.0-only",
		exports: {
			".": { types: "./dist/index.d.ts", default: "./dist/index.js" },
			"./openapi.json": "./openapi.json",
		},
		types: "./dist/index.d.ts",
		bin: { "gateweave-mail": "./dist/cli.js" },
	};
	const files: Record<string, string | undefined> = {
		"package/package.json": JSON.stringify(manifest),
		"package/README.md": "# @gateweave/mail\n",
		"package/LICENSE": AGPL,
		"package/openapi.json": "{}",
		"package/dist/index.js": "export {};\n",
		"package/dist/index.d.ts": "export {};\n",
		"package/dist/cli.js": "#!/usr/bin/env node\nexport {};\n",
		...changes,
	};
	const entries = Object.entries(files).filter((entry): entry is [string, string] => !!entry[1]);
	return readTar(tar(entries));
}

describe("readTar", () => {
	it("reads the plain files of an archive, with a pax header's long name", () => {
		const long = `package/dist/${"a".repeat(120)}.js`;
		const files = readTar(
			tar([
				["package/a.txt", "hello"],
				[long, "x".repeat(700)],
			]),
		);
		expect([...files.keys()]).toEqual(["package/a.txt", long]);
		expect(files.get("package/a.txt")?.toString()).toBe("hello");
		expect(files.get(long)?.length).toBe(700);
	});
});

describe("checkPackage", () => {
	it("passes a package that holds what it ships", () => {
		expect(checkPackage(packed(), "1.2.3")).toEqual([]);
	});

	it("finds what shouldn't be there, and what should be and isn't", () => {
		const problems = checkPackage(
			packed({
				"package/src/index.ts": "export {};\n",
				"package/dist/index.js.map": "{}",
				"package/.dev.vars": "SECRET=1\n",
				"package/LICENSE": undefined,
			}),
			"1.2.3",
		);
		expect(problems).toEqual([
			"package/src/index.ts shouldn't be in the package.",
			"package/dist/index.js.map shouldn't be in the package.",
			"package/.dev.vars shouldn't be in the package.",
			"The package has no LICENSE.",
			"LICENSE isn't the AGPL.",
		]);
	});

	it("wants the version being released, a command that runs and the files package.json names", () => {
		const manifest = {
			name: "@gateweave/mail",
			version: "1.2.4",
			license: "AGPL-3.0-only",
			exports: { ".": "./src/index.ts" },
			bin: { "gateweave-mail": "./dist/cli.js" },
			dependencies: { "@gateweave/mail-core": "workspace:*", zod: "4.1.0" },
		};
		const problems = checkPackage(
			packed({
				"package/package.json": JSON.stringify(manifest),
				"package/dist/cli.js": "export {};\n",
			}),
			"1.2.3",
		);
		expect(problems).toEqual([
			"dist/cli.js doesn't start with a shebang, so it won't run as a command.",
			"package.json isn't version 1.2.3.",
			"package.json's exports point at the sources, not dist/: is publishConfig applied?",
			"package.json's exports names ./src/index.ts, which the package doesn't hold.",
			"dependencies has @gateweave/mail-core as workspace:*, which only this workspace has.",
		]);
	});
});

describe("compareVersions", () => {
	it("orders versions as semver does", () => {
		const ordered = [
			"0.1.0",
			"0.2.0-alpha",
			"0.2.0-alpha.1",
			"0.2.0-alpha.beta",
			"0.2.0-beta.2",
			"0.2.0-beta.11",
			"0.2.0-rc.1",
			"0.2.0",
			"0.10.0",
			"1.0.0",
		];
		const shuffled = [...ordered].reverse();
		expect(shuffled.sort(compareVersions)).toEqual(ordered);
		expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
	});
});

describe("a release's files", () => {
	it("lives under its version, with sums sha256sum checks", () => {
		expect(releaseKeys("0.1.0")).toEqual({
			tarball: "mail/0.1.0/gateweave-mail-0.1.0.tgz",
			sums: "mail/0.1.0/SHA256SUMS",
			latest: "mail/latest.json",
		});
		expect(sha256sums([["gateweave-mail-0.1.0.tgz", "ab12"]])).toBe(
			"ab12  gateweave-mail-0.1.0.tgz\n",
		);
	});
});
