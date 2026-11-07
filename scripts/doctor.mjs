// Checks the local toolchain and setup, and says how to fix anything missing. Changes nothing.
// Run with `pnpm doctor`, or `node scripts/doctor.mjs` if pnpm itself is the problem.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";

const root = join(import.meta.dirname, "..");
const web = join(root, "apps", "web");
const failures = [];

function pass(message) {
	console.log(`  ok    ${message}`);
}

function warn(message, hint) {
	console.log(`  warn  ${message}\n        ${hint}`);
}

function fail(message, fix) {
	console.log(`  FAIL  ${message}\n        ${fix}`);
	failures.push(message);
}

console.log("Toolchain");

const wantedNode = readFileSync(join(root, ".node-version"), "utf8").trim();
const nodeMajor = Number(process.versions.node.split(".")[0]);
if (nodeMajor < 22) {
	fail(`Node.js ${process.versions.node} is too old`, `Install Node.js ${wantedNode}.`);
} else if (String(nodeMajor) !== wantedNode) {
	warn(`Node.js ${process.versions.node}`, `CI uses Node.js ${wantedNode}; 22+ works.`);
} else {
	pass(`Node.js ${process.versions.node}`);
}

// Package scripts call pnpm through the system shell, so check it the same way.
const wantedPnpm = JSON.parse(
	readFileSync(join(root, "package.json"), "utf8"),
).packageManager.split("@")[1];
const pnpm = spawnSync("pnpm --version", { shell: true, encoding: "utf8" });
const pnpmVersion = pnpm.status === 0 ? pnpm.stdout.trim() : null;
if (!pnpmVersion) {
	fail(
		"pnpm cannot be run from a shell, which package scripts need",
		`Install pnpm ${wantedPnpm}: https://pnpm.io/installation`,
	);
} else if (pnpmVersion !== wantedPnpm) {
	fail(
		`pnpm ${pnpmVersion}`,
		`This repository uses pnpm ${wantedPnpm}: pnpm self-update ${wantedPnpm}`,
	);
} else {
	pass(`pnpm ${pnpmVersion}`);
}

console.log("\nProject");

if (existsSync(join(root, "node_modules", ".pnpm"))) pass("Dependencies installed");
else fail("Dependencies are not installed", "Run: pnpm install");

const devVars = join(root, ".dev.vars");
const hasSecret =
	existsSync(devVars) && /^BETTER_AUTH_SECRET=\S+/m.test(readFileSync(devVars, "utf8"));
if (hasSecret) pass(".dev.vars has BETTER_AUTH_SECRET");
else if (existsSync(join(web, ".dev.vars"))) {
	fail(
		".dev.vars is still in apps/web; it now lives at the repository root",
		"Run: pnpm dev:setup",
	);
} else fail(".dev.vars is missing or has no BETTER_AUTH_SECRET", "Run: pnpm dev:setup");

const d1 = join(web, ".wrangler", "state", "v3", "d1");
const migrated =
	existsSync(d1) &&
	readdirSync(d1, { recursive: true }).some((file) => String(file).endsWith(".sqlite"));
if (migrated) pass("Local D1 database exists");
else fail("Local D1 database has not been created", "Run: pnpm dev:setup");

// Gateweave products use the 47xx range locally (site 4700, Track 4710, Mail 4750), away from
// the 3000s and 5173 that most other projects default to.
const PORT = 4750;
// Connect rather than listen: Vite binds "localhost", which can be ::1 only, so a test bind on
// 127.0.0.1 would succeed next to a running server.
const portFree = await new Promise((resolve) => {
	const socket = connect({ port: PORT, host: "localhost", autoSelectFamily: true })
		.once("connect", () => {
			socket.destroy();
			resolve(false);
		})
		.once("error", () => resolve(true));
});
if (portFree) pass(`Port ${PORT} is free for pnpm dev`);
else
	warn(
		`Port ${PORT} is in use`,
		`If it is not a Mail dev server, run on another port: pnpm --filter @gateweave/mail-web exec vite dev --port ${PORT + 1}`,
	);

if (failures.length > 0) {
	console.log(`\n${failures.length} problem(s) found.`);
	process.exitCode = 1;
} else {
	console.log("\nAll set. Start the app with: pnpm dev");
}
