/** At most `max` requests per `window` seconds. */
export interface Rule {
	window: number;
	max: number;
}

export interface Decision {
	allowed: boolean;
	/** Seconds until a request would be allowed, or null when this one was. */
	retryAfter: number | null;
}

/**
 * What a client has used of each rule: the time, in milliseconds, at which its allowance would be
 * whole again if it stopped now. Keyed by `ruleKey`.
 */
export type Allowance = Record<string, number>;

export function ruleKey(rule: Rule) {
	return `${rule.max}/${rule.window}`;
}

// Splitting a window into equal steps leaves floating-point error, so three steps of a third of a
// window can come to slightly more than one. A millisecond of slack absorbs it.
const SLACK_MS = 1;

/**
 * The generic cell rate algorithm. Each rule lets a client make `max` requests at once, then one
 * every `window / max` seconds, so the whole state is one timestamp per rule. A request is
 * allowed only if every rule allows it, and only an allowed request uses up allowance:
 * hammering a limit does not push it further away.
 */
export function take(
	allowance: Allowance,
	rules: readonly Rule[],
	now: number,
): { decision: Decision; allowance: Allowance } {
	const next = { ...allowance };
	let wait = 0;
	for (const rule of rules) {
		const window = rule.window * 1000;
		const key = ruleKey(rule);
		const used = Math.max(allowance[key] ?? now, now) + window / rule.max;
		next[key] = used;
		wait = Math.max(wait, used - window - now);
	}
	if (wait > SLACK_MS) {
		return { decision: { allowed: false, retryAfter: Math.ceil(wait / 1000) }, allowance };
	}
	return { decision: { allowed: true, retryAfter: null }, allowance: next };
}

/** When an allowance is whole again, after which it can be forgotten. */
export function refilledAt(allowance: Allowance) {
	return Math.max(0, ...Object.values(allowance));
}

/** Limits kept in this isolate's memory, for limits that need not hold across isolates. */
export class LocalLimiter {
	readonly #allowances = new Map<string, Allowance>();
	readonly #capacity: number;

	/** Keeps at most `capacity` clients, forgetting the oldest first when full. */
	constructor(capacity = 10_000) {
		this.#capacity = capacity;
	}

	consume(key: string, rules: readonly Rule[], now: number): Decision {
		const { decision, allowance } = take(this.#allowances.get(key) ?? {}, rules, now);
		if (decision.allowed) {
			this.#allowances.delete(key);
			this.#allowances.set(key, allowance);
			this.#prune(now);
		}
		return decision;
	}

	#prune(now: number) {
		if (this.#allowances.size <= this.#capacity) return;
		for (const [key, allowance] of this.#allowances) {
			if (refilledAt(allowance) <= now) this.#allowances.delete(key);
		}
		for (const key of this.#allowances.keys()) {
			if (this.#allowances.size <= this.#capacity) break;
			this.#allowances.delete(key);
		}
	}
}
