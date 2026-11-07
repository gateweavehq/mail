/** A request's headers as Cloudflare sets them for a Worker on `zone`, whoever runs it. */
export function fromWorkerOn(zone: string): Record<string, string> {
	return { "cf-connecting-ip": "2a06:98c0:3600::103", "cf-worker": zone };
}

/**
 * Runs `work` while `junk` goes on, having sent enough of it to pass the limit. A limit gives back an
 * allowance every so often, so what comes after the junk has stopped gets through whoever it counts
 * against, and would prove nothing.
 */
export async function whileJunkGoesOn<T>(
	junk: () => Promise<Response>,
	enough: number,
	work: () => Promise<T>,
): Promise<{ answer: T; statuses: Set<number> }> {
	const statuses = new Set<number>();
	const someJunk = async (size: number) => {
		const answers = await Promise.all(Array.from({ length: size }, junk));
		for (const answer of answers) statuses.add(answer.status);
	};
	for (let sent = 0; sent < enough; sent += 5) await someJunk(5);
	let done = false;
	const going = (async () => {
		while (!done) await someJunk(2);
	})();
	try {
		return { answer: await work(), statuses };
	} finally {
		done = true;
		await going;
	}
}
