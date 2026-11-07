import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("update-copy.mjs", import.meta.url));

const wrangler = (name, { database = "", comment = "// Optional: A." } = {}) =>
	`{\n\t"name": "${name}",\n\t"main": "server.js",\n\t"d1_databases": [{ "binding": "DB"${database} }],\n\t${comment}\n\t"vars": {}\n}\n`;

const RELEASES = {
	"v0.9.0": {
		"CHANGELOG.md": "# Changelog\n\n## [0.9.0] - 2026-01-01\n",
		"wrangler.jsonc": wrangler("gateweave-mail"),
		"package.json": '{ "name": "gateweave-mail" }\n',
		".github/workflows/ci.yml": "name: CI\n",
		"src/app.txt": "one\n",
		"src/gone.txt": "removed in the next release\n",
	},
	"v0.10.0": {
		"CHANGELOG.md": "# Changelog\n\n## [0.10.0] - 2026-02-01\n\n## [0.9.0] - 2026-01-01\n",
		"wrangler.jsonc": wrangler("gateweave-mail", { comment: "// Optional: A, B." }),
		"package.json": '{ "name": "gateweave-mail" }\n',
		".github/workflows/ci.yml": "name: CI\non: push\n",
		".github/workflows/release-notes.yml": "name: Release notes\n",
		"src/app.txt": "two\n",
		"src/new.txt": "added\n",
	},
};

let dir;
let upstream;
let copy;

function run(cwd, ...args) {
	return execFileSync("git", args, { cwd, encoding: "utf8", stdio: "pipe" }).trim();
}

function setUpRepository(path) {
	mkdirSync(path, { recursive: true });
	run(path, "init", "--quiet", "--initial-branch=main");
	run(path, "config", "user.name", "Test");
	run(path, "config", "user.email", "test@example.com");
	run(path, "config", "core.autocrlf", "false");
}

function writeTree(path, files) {
	for (const file of run(path, "ls-files").split("\n").filter(Boolean)) {
		rmSync(join(path, file));
	}
	for (const [file, text] of Object.entries(files)) {
		mkdirSync(dirname(join(path, file)), { recursive: true });
		writeFileSync(join(path, file), text);
	}
	run(path, "add", "-A");
}

function release(tag, files) {
	writeTree(upstream, files);
	run(upstream, "commit", "--quiet", "-m", `release ${tag}`);
	run(upstream, "tag", tag);
}

function update(...args) {
	return spawnSync("node", [SCRIPT, ...args], { cwd: copy, encoding: "utf8" });
}

const read = (file) => readFileSync(join(copy, file), "utf8");

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "mail-update-"));
	upstream = join(dir, "upstream");
	copy = join(dir, "copy");
	setUpRepository(upstream);
	release("v0.9.0", RELEASES["v0.9.0"]);
	release("v0.10.0", RELEASES["v0.10.0"]);

	// What the button makes from v0.9.0: one new commit, other names and no workflows.
	setUpRepository(copy);
	const { ".github/workflows/ci.yml": _, ...files } = RELEASES["v0.9.0"];
	writeTree(copy, {
		...files,
		"wrangler.jsonc": wrangler("my-id", { database: ', "database_id": "my-database"' }),
		"package.json": '{ "name": "my-id" }\n',
	});
	run(copy, "commit", "--quiet", "-m", "source repo import");
	run(copy, "remote", "add", "upstream", upstream);
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
});

test("a plain pull fails on a copy, which is why this script exists", () => {
	const pull = spawnSync("git", ["pull", "--no-rebase", "upstream", "main"], {
		cwd: copy,
		encoding: "utf8",
	});
	assert.notEqual(pull.status, 0);
	assert.match(pull.stderr, /unrelated histories/);
});

test("brings in the latest release as one commit, keeping what the copy changed", () => {
	const before = run(copy, "rev-parse", "HEAD");
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /from v0\.9\.0 to v0\.10\.0/);

	// The release's changes, additions and removals.
	assert.equal(read("src/app.txt"), "two\n");
	assert.equal(read("src/new.txt"), "added\n");
	assert.equal(existsSync(join(copy, "src/gone.txt")), false);
	assert.match(read("wrangler.jsonc"), /Optional: A, B\./);

	// The copy's own names, without which a deploy would make a new, empty app.
	assert.match(read("wrangler.jsonc"), /"name": "my-id"/);
	assert.match(read("wrangler.jsonc"), /"database_id": "my-database"/);
	assert.equal(read("package.json"), '{ "name": "my-id" }\n');

	// None of our workflows, changed or new.
	assert.equal(existsSync(join(copy, ".github/workflows/ci.yml")), false);
	assert.equal(existsSync(join(copy, ".github/workflows/release-notes.yml")), false);

	// One commit on the copy's history, with nothing left behind.
	assert.equal(run(copy, "log", "-1", "--format=%P"), before);
	assert.equal(run(copy, "log", "-1", "--format=%s"), "chore: update Mail to v0.10.0");
	assert.equal(run(copy, "status", "--porcelain"), "");
	assert.equal(run(copy, "replace", "--list"), "");
	assert.equal(run(copy, "for-each-ref", "refs/mail-upstream/replace/"), "");
	assert.equal(run(copy, "tag", "--list"), "");
});

test("runs from a pipe, as the first update of an old copy has to", () => {
	const piped = spawnSync("node", ["--input-type=module", "-", "--to", "v0.10.0"], {
		cwd: copy,
		input: readFileSync(SCRIPT, "utf8"),
		encoding: "utf8",
	});
	assert.equal(piped.status, 0, piped.stderr);
	assert.equal(read("src/app.txt"), "two\n");
});

test("runs from Windows PowerShell's pipe, which starts with a byte order mark", () => {
	const piped = spawnSync("node", ["--input-type=module"], {
		cwd: copy,
		input: `\uFEFF${readFileSync(SCRIPT, "utf8")}`,
		encoding: "utf8",
	});
	assert.equal(piped.status, 0, piped.stderr);
	assert.equal(read("src/app.txt"), "two\n");
});

test("updates again from the release it reached, with the copy's later changes kept", () => {
	assert.equal(update().status, 0);
	writeFileSync(join(copy, "local.txt"), "ours\n");
	run(copy, "add", "-A");
	run(copy, "commit", "--quiet", "-m", "something of ours");

	release("v0.11.0", {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": `# Changelog\n\n## [0.11.0] - 2026-03-01\n\n${RELEASES["v0.10.0"]["CHANGELOG.md"].slice(13)}`,
		".github/workflows/ci.yml": "name: CI\non: pull_request\n",
		"src/app.txt": "three\n",
	});
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(read("src/app.txt"), "three\n");
	assert.equal(read("local.txt"), "ours\n");
	assert.match(read("wrangler.jsonc"), /"name": "my-id"/);
	assert.equal(existsSync(join(copy, ".github/workflows/ci.yml")), false);
});

test("orders releases as numbers, and takes the one it is asked for", () => {
	const result = update("--to", "v0.9.0");
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Already on v0\.9\.0/);
	assert.equal(update().status, 0);
	assert.match(read("CHANGELOG.md"), /## \[0\.10\.0\]/);
});

test("says so when the copy is up to date, and refuses to go back", () => {
	assert.equal(update().status, 0);
	const head = run(copy, "rev-parse", "HEAD");

	const again = update();
	assert.equal(again.status, 0);
	assert.match(again.stdout, /Already on v0\.10\.0/);

	const back = update("--to", "v0.9.0");
	assert.equal(back.status, 1);
	assert.match(back.stderr, /newer than v0\.9\.0/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
});

test("refuses a release that does not exist", () => {
	const result = update("--to", "v9.9.9");
	assert.equal(result.status, 1);
	assert.match(result.stderr, /no release v9\.9\.9/);
});

test("touches nothing while there are uncommitted changes", () => {
	writeFileSync(join(copy, "src/app.txt"), "being edited\n");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /uncommitted changes/);
	assert.equal(read("src/app.txt"), "being edited\n");
});

test("leaves real conflicts to be resolved, naming them, with nothing grafted", () => {
	writeFileSync(join(copy, "src/app.txt"), "our own one\n");
	run(copy, "add", "-A");
	run(copy, "commit", "--quiet", "-m", "something of ours");
	const head = run(copy, "rev-parse", "HEAD");

	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /src\/app\.txt/);
	assert.doesNotMatch(result.stderr, /workflows/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
	assert.equal(run(copy, "replace", "--list"), "");
	assert.equal(run(copy, "for-each-ref", "refs/mail-upstream/replace/"), "");
	assert.match(read("src/app.txt"), /<<<<<<</);
});

test("stops rather than point the copy at another Worker", () => {
	// A copy that renamed nothing takes a rename from a release without a conflict, so only this
	// check catches it.
	writeTree(copy, {
		...Object.fromEntries(
			Object.entries(RELEASES["v0.9.0"]).filter(([file]) => !file.includes("workflows")),
		),
	});
	run(copy, "commit", "--quiet", "-m", "back to the original names");
	release("v0.11.0", {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": "# Changelog\n\n## [0.11.0] - 2026-03-01\n",
		"wrangler.jsonc": wrangler("renamed-by-us"),
	});
	const head = run(copy, "rev-parse", "HEAD");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /another Worker, database or queue/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
	assert.equal(run(copy, "status", "--porcelain"), "");
});

const QUEUE_LINE = (name) => `"queues": { "producers": [{ "queue": "${name}" }] },\n\t"vars": {}`;
const withQueue = (name) => wrangler("gateweave-mail").replace('"vars": {}', QUEUE_LINE(name));
const ORIGINAL = () =>
	Object.fromEntries(
		Object.entries(RELEASES["v0.9.0"]).filter(([file]) => !file.includes("workflows")),
	);

test("stops rather than point the copy at another database", () => {
	writeTree(copy, ORIGINAL());
	run(copy, "commit", "--quiet", "-m", "back to the original names");
	release("v0.11.0", {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": "# Changelog\n\n## [0.11.0] - 2026-03-01\n",
		"wrangler.jsonc": wrangler("gateweave-mail").replace(
			'"binding": "DB"',
			'"binding": "DB", "database_name": "renamed-by-us"',
		),
	});
	const head = run(copy, "rev-parse", "HEAD");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /another Worker, database or queue/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
	assert.equal(run(copy, "status", "--porcelain"), "");
});

test("stops rather than point the copy at another queue", () => {
	const withItsQueue = {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": "# Changelog\n\n## [0.11.0] - 2026-03-01\n",
		"wrangler.jsonc": withQueue("gateweave-mail-logouts"),
	};
	release("v0.11.0", withItsQueue);
	writeTree(
		copy,
		Object.fromEntries(
			Object.entries(withItsQueue).filter(([file]) => !file.includes("workflows")),
		),
	);
	run(copy, "commit", "--quiet", "-m", "a copy of the release with a queue");
	release("v0.12.0", {
		...withItsQueue,
		"CHANGELOG.md": "# Changelog\n\n## [0.12.0] - 2026-04-01\n",
		"wrangler.jsonc": withQueue("renamed-by-us"),
	});
	const head = run(copy, "rev-parse", "HEAD");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /another Worker, database or queue/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
	assert.equal(run(copy, "status", "--porcelain"), "");
});

test("takes a first queue from a release, for a copy from before there were any", () => {
	writeTree(copy, ORIGINAL());
	run(copy, "commit", "--quiet", "-m", "back to the original names");
	release("v0.11.0", {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": "# Changelog\n\n## [0.11.0] - 2026-03-01\n",
		"wrangler.jsonc": withQueue("gateweave-mail-logouts"),
	});
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.match(read("wrangler.jsonc"), /gateweave-mail-logouts/);
});

test("minds nothing a release changes in its own environments", () => {
	const withEnv = (id) =>
		wrangler("gateweave-mail", {
			comment: `"env": { "staging": { "name": "x", "database_id": "${id}" } },`,
		});
	writeTree(copy, {
		...Object.fromEntries(
			Object.entries(RELEASES["v0.9.0"]).filter(([file]) => !file.includes("workflows")),
		),
	});
	run(copy, "commit", "--quiet", "-m", "back to the original names");
	release("v0.11.0", {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": "# Changelog\n\n## [0.11.0] - 2026-03-01\n",
		"wrangler.jsonc": withEnv("new-staging-database"),
	});
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.match(read("wrangler.jsonc"), /new-staging-database/);
});

const WORKER = "gateweave-mail";
const changelog = (version, date) => `# Changelog\n\n## [${version}] - ${date}\n`;
const addingToConfig = (lines) => wrangler(WORKER).replace('"vars": {}', `${lines},\n\t"vars": {}`);

/** A copy on a release whose wrangler.jsonc is `first`, then a newer release whose file is `second`. */
function updatingBetween(first, second, ours = first) {
	const base = {
		...RELEASES["v0.10.0"],
		"CHANGELOG.md": changelog("0.11.0", "2026-03-01"),
		"wrangler.jsonc": first,
	};
	release("v0.11.0", base);
	writeTree(copy, {
		...Object.fromEntries(Object.entries(base).filter(([file]) => !file.includes("workflows"))),
		"wrangler.jsonc": ours,
	});
	run(copy, "commit", "--quiet", "-m", "a copy of that release");
	release("v0.12.0", {
		...base,
		"CHANGELOG.md": changelog("0.12.0", "2026-04-01"),
		"wrangler.jsonc": second,
	});
	return run(copy, "rev-parse", "HEAD");
}

test("notices a rename when a comment before it mentions an environment", () => {
	const commented = (name) => wrangler(name).replace("{\n", '{\n\t// "env": none of ours yet\n');
	const head = updatingBetween(commented(WORKER), commented("renamed-by-us"));
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /another Worker, database or queue/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
});

test("takes a binding a release renames, which is no Worker's name", () => {
	const binding = (name) =>
		addingToConfig(
			`"durable_objects": { "bindings": [{ "name": "${name}", "class_name": "Thing" }] }`,
		);
	updatingBetween(binding("OLD_THING"), binding("NEW_THING"));
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.match(read("wrangler.jsonc"), /NEW_THING/);
});

test("stops rather than give a binding another database, even with the old one kept", () => {
	const databases = (...pairs) =>
		wrangler(WORKER).replace(
			'{ "binding": "DB" }',
			pairs
				.map(([binding, name]) => `{ "binding": "${binding}", "database_name": "${name}" }`)
				.join(", "),
		);
	const head = updatingBetween(
		databases(["DB", "our-accounts"]),
		databases(["DB", "new-accounts"], ["ARCHIVE", "our-accounts"]),
	);
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /another Worker, database or queue/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
});

test("takes a queue a release adds beside the one a copy has", () => {
	const queues = (...names) =>
		addingToConfig(
			`"queues": { "producers": [${names.map((name) => `{ "queue": "${name}" }`).join(", ")}] }`,
		);
	updatingBetween(queues("our-work"), queues("our-work", "more-work"));
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.match(read("wrangler.jsonc"), /more-work/);
});

test("reads a trailing comma, and a string that looks like a comment", () => {
	const config = (name) =>
		`{\n\t"name": "${name}",\n\t"main": "https://example.test//x",\n\t"vars": {},\n}\n`;
	const head = updatingBetween(config(WORKER), config("renamed-by-us"));
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /another Worker, database or queue/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
});

test("stops when it cannot read wrangler.jsonc", () => {
	const good = wrangler(WORKER);
	const head = updatingBetween(good, good, good.replace('"vars": {}', '"vars": {'));
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /could not be read/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
	assert.equal(run(copy, "status", "--porcelain"), "");
});

test("leaves wrangler.jsonc to a person when the copy did more than rewrite lines", () => {
	const added = read("wrangler.jsonc").replace('\t"main"', '\t"routes": [],\n\t"main"');
	writeFileSync(
		join(copy, "wrangler.jsonc"),
		added.replace("// Optional: A.", '"tail_consumers": [],\n\t// Optional: A.'),
	);
	run(copy, "add", "-A");
	run(copy, "commit", "--quiet", "-m", "routes of our own");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /wrangler\.jsonc/);
	assert.match(read("wrangler.jsonc"), /<<<<<<</);
});

/** A release with a setting on two lines alike, in two environments, each with a line beside it. */
const twoEnvironments = (cloud, staging, beside) =>
	wrangler(WORKER, {
		comment: `"env": {
		"cloud": {
			${cloud}
			"first": 1
		},
		"staging": {
			${staging}
			"second": ${beside}
		}
	},`,
	});

test("leaves wrangler.jsonc to a person when a line the copy rewrote appears twice", () => {
	const line = (value) => `"vars": { "LIMIT": "${value}" },`;
	updatingBetween(
		twoEnvironments(line(1), line(1), 1),
		twoEnvironments(line(1), line(1), 2),
		twoEnvironments(line(1), line(2), 1),
	);
	const result = update();
	assert.equal(result.status, 1, "the copy's staging change must not land on cloud's line");
	assert.match(result.stderr, /wrangler\.jsonc/);
	assert.match(read("wrangler.jsonc"), /<<<<<<</);
});

test("leaves wrangler.jsonc to a person when a release keeps only one of two lines alike", () => {
	const line = (value) => `"vars": { "LIMIT": "${value}" },`;
	updatingBetween(
		twoEnvironments(line(1), line(1), 1),
		twoEnvironments(line(1), '"vars": {},', 1),
		twoEnvironments(line(1), line(2), 1),
	);
	const result = update();
	assert.equal(result.status, 1, "the copy's staging change must not land on cloud's line");
	assert.match(result.stderr, /wrangler\.jsonc/);
	assert.match(read("wrangler.jsonc"), /<<<<<<</);
});

test("leaves wrangler.jsonc to a person when a release repeats a line the copy rewrote", () => {
	const line = (value) => `"vars": { "LIMIT": "${value}" },`;
	updatingBetween(
		twoEnvironments('"vars": {},', line(1), 1),
		twoEnvironments(line(1), line(1), 2),
		twoEnvironments('"vars": {},', line(2), 1),
	);
	const result = update();
	assert.equal(result.status, 1, "the copy's staging change must not land on cloud's new line");
	assert.match(result.stderr, /wrangler\.jsonc/);
	assert.match(read("wrangler.jsonc"), /<<<<<<</);
});

/** A commit of the copy's own, so that its newest commit has a parent a replacement can take away. */
function commitOfOurOwn() {
	writeFileSync(join(copy, "ours.txt"), "ours\n");
	run(copy, "add", "-A");
	run(copy, "commit", "--quiet", "-m", "something of ours");
	return run(copy, "rev-parse", "HEAD");
}

test("is not stopped by what a run that stopped halfway left", () => {
	const head = commitOfOurOwn();
	execFileSync("git", ["replace", "--graft", head], {
		cwd: copy,
		env: { ...process.env, GIT_REPLACE_REF_BASE: "refs/mail-upstream/replace/" },
	});
	assert.notEqual(
		run(copy, "rev-parse", "HEAD~1"),
		"",
		"the copy's own git still sees its history",
	);

	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(run(copy, "rev-parse", "HEAD~1"), head);
	assert.equal(run(copy, "for-each-ref", "refs/mail-upstream/replace/"), "");
});

test("leaves a replacement of the copy's own alone", () => {
	const head = commitOfOurOwn();
	run(copy, "replace", "--graft", head);

	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(run(copy, "replace", "--list"), head);
	assert.equal(run(copy, "--no-replace-objects", "log", "-1", "--format=%P"), head);
});

test("stops before the copy's own replacement, on a git with no other place", () => {
	const head = commitOfOurOwn();
	run(copy, "replace", "--graft", head);
	// Such a git works as this script does without the line that names the other place.
	const script = readFileSync(SCRIPT, "utf8");
	const ignoring = script.replace(/^process\.env\.GIT_REPLACE_REF_BASE = .*$/m, "");
	assert.notEqual(ignoring, script);
	writeFileSync(join(dir, "ignoring.mjs"), ignoring);

	const result = spawnSync("node", [join(dir, "ignoring.mjs")], { cwd: copy, encoding: "utf8" });
	assert.equal(result.status, 1);
	assert.match(result.stderr, /git replace failed/);
	assert.equal(run(copy, "rev-parse", "HEAD"), head);
	assert.equal(run(copy, "replace", "--list"), head);
	assert.equal(run(copy, "log", "-1", "--format=%P"), "", "the copy's own, as it made it");
});

const withDependabot = (version, file) => ({
	...RELEASES["v0.10.0"],
	"CHANGELOG.md": `# Changelog\n\n## [${version}] - 2026-03-01\n`,
	".github/dependabot.yml": file,
});

test("keeps Dependabot's file out of a copy that does not have it", () => {
	release("v0.11.0", withDependabot("0.11.0", "version: 2\n"));
	assert.equal(update().status, 0);
	assert.equal(existsSync(join(copy, ".github/dependabot.yml")), false);

	release("v0.12.0", withDependabot("0.12.0", "version: 2\nupdates: []\n"));
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(existsSync(join(copy, ".github/dependabot.yml")), false);
});

test("updates Dependabot's file in a copy that kept it", () => {
	release("v0.11.0", withDependabot("0.11.0", "version: 2\n"));
	mkdirSync(join(copy, ".github"), { recursive: true });
	writeFileSync(join(copy, ".github/dependabot.yml"), "version: 2\n");
	run(copy, "add", "-A");
	run(copy, "commit", "--quiet", "-m", "as the button would have left it");
	assert.equal(update().status, 0);

	release("v0.12.0", withDependabot("0.12.0", "version: 2\nupdates: []\n"));
	const result = update();
	assert.equal(result.status, 0, result.stderr);
	assert.equal(read(".github/dependabot.yml"), "version: 2\nupdates: []\n");
});

test("refuses Mail's own repository", () => {
	run(copy, "remote", "add", "origin", "https://github.com/gateweavehq/mail.git");
	const result = update();
	assert.equal(result.status, 1);
	assert.match(result.stderr, /own repository/);
});
