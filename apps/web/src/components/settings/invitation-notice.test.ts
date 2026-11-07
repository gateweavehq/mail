import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { InvitationNotice, resentNotice } from "./invitation-notice";

const notice = (byEmail: boolean) =>
	renderToStaticMarkup(createElement(InvitationNotice, { byEmail, email: "maya@example.com" }));

describe("what the members page says about an invitation", () => {
	it("does not say the mail went, since it goes in the background, and offers the link", () => {
		const said = notice(true);
		expect(said).toContain("We are emailing an invitation to");
		expect(said).toContain("maya@example.com");
		expect(said).toContain("If it does not arrive, send them this link");
		expect(said).not.toContain("emailed");
	});

	it("says the same when asked again", () => {
		const { title, description } = resentNotice("maya@example.com");
		expect(title).toBe("Emailing the invitation to maya@example.com again");
		expect(title).not.toContain("emailed");
		expect(description).toContain("If it does not arrive");
	});

	it("only offers the link where the server emails nothing", () => {
		const said = notice(false);
		expect(said).toContain("Send this link to");
		expect(said).not.toContain("emailing");
	});
});
