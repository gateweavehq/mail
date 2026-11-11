#!/usr/bin/env node
// The gateweave-mail command: run.ts's `run`, with this process's environment, streams and files.

import { readFile } from "node:fs/promises";
import { run } from "./run.js";

process.exitCode = await run(process.argv.slice(2), {
	env: process.env,
	async stdin() {
		const chunks: Uint8Array[] = [];
		for await (const chunk of process.stdin) chunks.push(chunk as Uint8Array);
		return Buffer.concat(chunks);
	},
	stdinIsTTY: process.stdin.isTTY === true,
	stdout: (text) => {
		process.stdout.write(text);
	},
	stderr: (text) => {
		process.stderr.write(text);
	},
	readFile: (path) => readFile(path),
});
