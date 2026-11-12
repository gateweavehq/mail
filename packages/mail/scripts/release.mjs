// Puts a release of @gateweave/mail on pkg.gateweave.com, Gateweave's own place for its packages,
// an R2 bucket, until the package goes to npm:
//
//   pnpm --filter @gateweave/mail release --dry-run   builds, packs and checks; uploads nothing
//   pnpm --filter @gateweave/mail release             and uploads, from a clean commit on main
//
// It builds dist/ afresh and packs the package as npm would publish it: `pnpm pack` applies
// publishConfig. It checks what the tarball holds, unpacks it and runs it, then uploads it with
// the pinned Wrangler as whoever runs it, who needs write access to the bucket. With more than one
// Cloudflare account, set CLOUDFLARE_ACCOUNT_ID.
//
// A release is mail/<version>/gateweave-mail-<version>.tgz and mail/<version>/SHA256SUMS, and
// neither is ever written twice: the bucket's lock rules refuse to overwrite or delete anything
// under mail/0 to mail/9. A run that finds them there already with the same bytes goes on, so one
// that stopped halfway can run again. Then mail/latest.json names the release, unless it names a
// later one or the version is a prerelease.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";

export const BASE = "https://pkg.gateweave.com";
const BUCKET = "gateweave-pkg";
const FOLDER = "mail";
const NAME = "@gateweave/mail";
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const FOREVER = "public, max-age=31536000, immutable";
const BRIEFLY = "public, max-age=300";

/** @param {string} version */
export function tarballName(version) {
	return `gateweave-mail-${version}.tgz`;
}

/** The keys of a release in the bucket, which are also its paths under BASE. */
export function releaseKeys(/** @type {string} */ version) {
	return {
		tarball: `${FOLDER}/${version}/${tarballName(version)}`,
		sums: `${FOLDER}/${version}/SHA256SUMS`,
		latest: `${FOLDER}/latest.json`,
	};
}

/**
 * The regular files in an uncompressed tar archive, by name. It reads what `pnpm pack` writes:
 * ustar headers, with a pax header now and then for a long name.
 * @param {Uint8Array} archive
 * @returns {Map<string, Buffer>}
 */
export function readTar(archive) {
	const bytes = Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength);
	/** @type {Map<string, Buffer>} */
	const files = new Map();
	/** @type {string | undefined} */
	let longName;
	let at = 0;
	while (at + 512 <= bytes.length) {
		const header = bytes.subarray(at, at + 512);
		if (header.every((byte) => byte === 0)) break;
		const text = (/** @type {number} */ from, /** @type {number} */ to) =>
			header.toString("utf8", from, to).replace(/\0.*$/s, "");
		const size = Number.parseInt(text(124, 136).trim() || "0", 8);
		if (!Number.isSafeInteger(size)) throw new Error("A tar header has no size.");
		const body = bytes.subarray(at + 512, at + 512 + size);
		const type = text(156, 157) || "0";
		const prefix = text(345, 500);
		const name = longName ?? (prefix ? `${prefix}/${text(0, 100)}` : text(0, 100));
		at += 512 + Math.ceil(size / 512) * 512;
		if (type === "x") {
			longName = /(?:^|\n)\d+ path=([^\n]*)\n/.exec(body.toString("utf8"))?.[1];
			continue;
		}
		longName = undefined;
		if (type === "0") files.set(name, Buffer.from(body));
		else if (type !== "5") throw new Error(`The tarball holds ${name}, which isn't a plain file.`);
	}
	return files;
}

/**
 * What is wrong with a packed release, if anything: only what the package ships, with nothing of
 * the workspace's left in it, and every file its package.json names there.
 * @param {Map<string, Buffer>} files
 * @param {string} version
 * @returns {string[]}
 */
export function checkPackage(files, version) {
	/** @type {string[]} */
	const problems = [];
	for (const name of files.keys()) {
		const path = name.startsWith("package/") ? name.slice("package/".length) : undefined;
		const shipped =
			path !== undefined &&
			(["package.json", "README.md", "LICENSE", "openapi.json"].includes(path) ||
				/^dist\/[\w.-]+\.(?:js|d\.ts)$/.test(path));
		if (!shipped) problems.push(`${name} shouldn't be in the package.`);
	}
	for (const path of ["README.md", "LICENSE", "openapi.json", "dist/index.js", "dist/cli.js"]) {
		if (!files.has(`package/${path}`)) problems.push(`The package has no ${path}.`);
	}
	if (!files.get("package/dist/cli.js")?.toString("utf8").startsWith("#!/usr/bin/env node\n")) {
		problems.push("dist/cli.js doesn't start with a shebang, so it won't run as a command.");
	}
	if (
		!files.get("package/LICENSE")?.toString("utf8").includes("GNU AFFERO GENERAL PUBLIC LICENSE")
	) {
		problems.push("LICENSE isn't the AGPL.");
	}
	const raw = files.get("package/package.json");
	/** @type {unknown} */
	let manifest;
	try {
		manifest = raw ? JSON.parse(raw.toString("utf8")) : undefined;
	} catch {
		manifest = undefined;
	}
	if (manifest === undefined) return [...problems, "The package has no readable package.json."];
	if (at(manifest, "name") !== NAME) problems.push(`package.json doesn't name ${NAME}.`);
	if (at(manifest, "version") !== version) problems.push(`package.json isn't version ${version}.`);
	if (at(manifest, "license") !== "AGPL-3.0-only")
		problems.push("package.json isn't AGPL-3.0-only.");
	if (at(manifest, "exports", ".", "default") !== "./dist/index.js") {
		problems.push(
			"package.json's exports point at the sources, not dist/: is publishConfig applied?",
		);
	}
	for (const field of ["exports", "bin", "types", "main"]) {
		for (const target of leaves(at(manifest, field))) {
			if (!target.startsWith("./") || !files.has(`package/${target.slice(2)}`)) {
				problems.push(`package.json's ${field} names ${target}, which the package doesn't hold.`);
			}
		}
	}
	for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
		const specs = at(manifest, field);
		if (typeof specs !== "object" || specs === null) continue;
		for (const [dependency, spec] of Object.entries(specs)) {
			if (typeof spec !== "string" || /^(?:workspace|catalog|link|file):/.test(spec)) {
				problems.push(
					`${field} has ${dependency} as ${String(spec)}, which only this workspace has.`,
				);
			}
		}
	}
	return problems;
}

/**
 * The value at a path of keys into parsed JSON, or undefined.
 * @param {unknown} value
 * @param {string[]} keys
 * @returns {unknown}
 */
function at(value, ...keys) {
	let here = value;
	for (const key of keys) {
		if (typeof here !== "object" || here === null) return undefined;
		here = /** @type {Record<string, unknown>} */ (here)[key];
	}
	return here;
}

/**
 * Every string in parsed JSON.
 * @param {unknown} value
 * @returns {string[]}
 */
function leaves(value) {
	if (typeof value === "string") return [value];
	if (typeof value !== "object" || value === null) return [];
	return Object.values(value).flatMap(leaves);
}

/**
 * A SHA256SUMS file, as `sha256sum -c` reads one.
 * @param {[name: string, sha256: string][]} entries
 */
export function sha256sums(entries) {
	return entries.map(([name, sha256]) => `${sha256}  ${name}\n`).join("");
}

/**
 * Orders two versions as semver does: by their numbers, then a release after its prereleases.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
export function compareVersions(a, b) {
	const [x, y] = [a, b].map((version) => {
		const dash = version.indexOf("-");
		return {
			core: (dash === -1 ? version : version.slice(0, dash)).split(".").map(Number),
			pre: dash === -1 ? [] : version.slice(dash + 1).split("."),
		};
	});
	if (!x || !y) return 0;
	for (let i = 0; i < 3; i++) {
		const difference = (x.core[i] ?? 0) - (y.core[i] ?? 0);
		if (difference !== 0) return Math.sign(difference);
	}
	if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length);
	for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
		const [p, q] = [x.pre[i], y.pre[i]];
		if (p === undefined) return -1;
		if (q === undefined) return 1;
		if (p === q) continue;
		const [m, n] = [/^\d+$/.test(p), /^\d+$/.test(q)];
		if (m && n) return Math.sign(Number(p) - Number(q));
		if (m !== n) return m ? -1 : 1;
		return p < q ? -1 : 1;
	}
	return 0;
}

/** Why a release stopped, said to whoever ran it without a stack. */
class Stop extends Error {}

/** @param {string} message @returns {never} */
function stop(message) {
	throw new Stop(message);
}

/** @param {Uint8Array} bytes */
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

/**
 * Runs a command without a shell, and stops if it fails.
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, quiet?: boolean }} options
 */
function run(command, args, { cwd, quiet = false }) {
	const result = spawnSync(command, args, {
		cwd,
		encoding: "utf8",
		stdio: quiet ? "pipe" : ["ignore", "inherit", "inherit"],
	});
	if (result.status !== 0) {
		if (quiet) process.stderr.write(result.stderr ?? "");
		stop(
			`${[command, ...args].join(" ")} failed${result.error ? `: ${result.error.message}` : "."}`,
		);
	}
	return (result.stdout ?? "").trim();
}

/**
 * An object under BASE as it is now, past any cache, or null when there is none.
 * @param {string} key
 */
async function fetchNow(key) {
	const response = await fetch(`${BASE}/${key}?now=${Date.now()}`, {
		headers: { "cache-control": "no-cache" },
	});
	if (response.status === 404) return null;
	if (!response.ok) stop(`${BASE}/${key} answered ${response.status}.`);
	return new Uint8Array(await response.arrayBuffer());
}

async function main() {
	const dryRun = process.argv.includes("--dry-run");
	const here = dirname(fileURLToPath(import.meta.url));
	const packageDir = resolve(here, "..");
	const root = resolve(packageDir, "../..");
	const pnpm = process.env.npm_execpath;
	if (!pnpm) stop("Run it through pnpm: pnpm --filter @gateweave/mail release");
	/** @param {string[]} args @param {string} cwd */
	const runPnpm = (args, cwd) =>
		/\.[cm]?js$/.test(pnpm)
			? run(process.execPath, [pnpm, ...args], { cwd })
			: run(pnpm, args, { cwd });
	const wrangler = join(root, "apps/web/node_modules/wrangler/bin/wrangler.js");
	if (!existsSync(wrangler)) stop("Wrangler isn't installed: run pnpm install first.");

	const manifest = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
	const version = String(manifest.version);
	if (!VERSION.test(version)) stop(`${version} isn't a version this can release.`);
	const keys = releaseKeys(version);

	const commit = run("git", ["rev-parse", "HEAD"], { cwd: root, quiet: true });
	if (!dryRun) {
		if (run("git", ["status", "--porcelain", "--", "."], { cwd: packageDir, quiet: true })) {
			stop("packages/mail has changes that aren't committed. Release from a clean commit.");
		}
		const onMain = spawnSync("git", ["merge-base", "--is-ancestor", "HEAD", "origin/main"], {
			cwd: root,
		});
		if (onMain.status !== 0) {
			stop("HEAD isn't on origin/main. Fetch it, check out a commit on main and run this again.");
		}
	}

	console.log(`Building and packing ${NAME} ${version}.`);
	rmSync(join(packageDir, "dist"), { recursive: true, force: true });
	runPnpm(["run", "build"], packageDir);
	const work = mkdtempSync(join(tmpdir(), "gateweave-mail-release-"));
	try {
		runPnpm(["pack", "--pack-destination", work], packageDir);
		const tarball = join(work, tarballName(version));
		if (!existsSync(tarball)) stop(`pnpm pack made no ${tarballName(version)}.`);
		const bytes = readFileSync(tarball);
		const files = readTar(gunzipSync(bytes));
		const problems = checkPackage(files, version);
		if (problems.length > 0) stop(`The package isn't right:\n- ${problems.join("\n- ")}`);

		// Unpacked into a node_modules, as an install would leave it (it has no dependencies), it has
		// to run as a command and load as a module.
		const project = join(work, "try");
		const installed = join(project, "node_modules", ...NAME.split("/"));
		for (const [name, body] of files) {
			const path = join(installed, name.slice("package/".length));
			mkdirSync(dirname(path), { recursive: true });
			writeFileSync(path, body);
		}
		writeFileSync(join(project, "package.json"), '{ "private": true, "type": "module" }\n');
		const said = run(process.execPath, [join(installed, "dist/cli.js"), "--version"], {
			cwd: project,
			quiet: true,
		});
		if (said !== version) stop(`The packed command says it is ${said}, not ${version}.`);
		run(
			process.execPath,
			[
				"--input-type=module",
				"-e",
				`const sdk = await import("${NAME}");
				if (typeof sdk.MailClient !== "function" || sdk.VERSION !== process.argv[1]) process.exit(1);`,
				version,
			],
			{ cwd: project, quiet: true },
		);

		const sum = sha256(bytes);
		const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
		const sums = Buffer.from(sha256sums([[tarballName(version), sum]]));
		writeFileSync(join(work, "SHA256SUMS"), sums);
		console.log(`Packed ${files.size} files, ${bytes.length} bytes, sha256 ${sum}.`);
		if (dryRun) {
			console.log(`Dry run: nothing uploaded. It would go to ${BASE}/${keys.tarball}.`);
			return;
		}

		/** @param {string} key @param {string} path @param {string} type @param {string} cache */
		const put = (key, path, type, cache) =>
			run(
				process.execPath,
				[wrangler, "r2", "object", "put", `${BUCKET}/${key}`, "--remote"].concat([
					"--file",
					path,
					"--content-type",
					type,
					"--cache-control",
					cache,
				]),
				{ cwd: work },
			);
		/** @param {string} key @param {string} path @param {string} type */
		const putOnce = async (key, path, type) => {
			const mine = readFileSync(path);
			const there = await fetchNow(key);
			if (there && sha256(there) !== sha256(mine)) {
				stop(
					`${BASE}/${key} is there already, with other bytes. A release is never written twice: raise the version.`,
				);
			}
			if (there) console.log(`${key} is there already, the same.`);
			else put(key, path, type, FOREVER);
			const now = await fetchNow(key);
			if (!now || sha256(now) !== sha256(mine))
				stop(`${BASE}/${key} doesn't serve what was uploaded.`);
		};
		await putOnce(keys.tarball, tarball, "application/gzip");
		await putOnce(keys.sums, join(work, "SHA256SUMS"), "text/plain; charset=utf-8");

		const current = await fetchNow(keys.latest);
		const named = current
			? at(JSON.parse(Buffer.from(current).toString("utf8")), "version")
			: undefined;
		if (version.includes("-")) {
			console.log("A prerelease: latest.json stays as it is.");
		} else if (typeof named === "string" && compareVersions(named, version) >= 0) {
			console.log(`latest.json names ${named}, and stays as it is.`);
		} else {
			const latest = {
				name: NAME,
				version,
				tarball: `${BASE}/${keys.tarball}`,
				sha256: sum,
				integrity,
				commit,
				published: new Date().toISOString(),
			};
			writeFileSync(join(work, "latest.json"), `${JSON.stringify(latest, null, "\t")}\n`);
			put(keys.latest, join(work, "latest.json"), "application/json", BRIEFLY);
		}
		console.log(
			`\nReleased ${NAME} ${version}:\n  npm install ${BASE}/${keys.tarball}\n  sha256 ${sum}`,
		);
	} finally {
		rmSync(work, { recursive: true, force: true });
	}
}

const self = fileURLToPath(import.meta.url);
const direct =
	import.meta.main ??
	(process.argv[1] !== undefined && resolve(process.argv[1]).toLowerCase() === self.toLowerCase());
if (direct) {
	try {
		await main();
	} catch (error) {
		if (!(error instanceof Stop)) throw error;
		console.error(error.message);
		process.exitCode = 1;
	}
}
