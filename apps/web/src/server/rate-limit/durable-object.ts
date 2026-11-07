import { DurableObject } from "cloudflare:workers";
import { type Allowance, type Decision, type Rule, refilledAt, take } from "./gcra";

const ALLOWANCE = "allowance";

/**
 * Counts one client's requests, or one recipient's emails, across every isolate and location.
 * Each key gets its own instance, which Cloudflare places near whoever used it first. `consume`
 * never awaits, so concurrent requests are decided one at a time.
 */
export class RateLimiter extends DurableObject {
	consume(rules: Rule[]): Decision {
		const { kv } = this.ctx.storage;
		const { decision, allowance } = take(kv.get<Allowance>(ALLOWANCE) ?? {}, rules, Date.now());
		if (decision.allowed) {
			kv.put(ALLOWANCE, allowance);
			void this.ctx.storage.setAlarm(refilledAt(allowance));
		}
		return decision;
	}

	/** Once the allowance is whole again, it is the same as none, so nothing is kept. */
	override async alarm(): Promise<void> {
		const refilled = refilledAt(this.ctx.storage.kv.get<Allowance>(ALLOWANCE) ?? {});
		if (refilled > Date.now()) await this.ctx.storage.setAlarm(refilled);
		else await this.ctx.storage.deleteAll();
	}
}
