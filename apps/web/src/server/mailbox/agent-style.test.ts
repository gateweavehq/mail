import { describe, expect, it } from "vitest";
import { agentStyle } from "./agent-style";

describe("agent inline styles", () => {
	it.each([
		"position:absolute",
		"display:none",
		"visibility:hidden",
		"opacity:0",
		"transform:translateY(-100%)",
		"z-index:999",
		"clip:rect(0,0,0,0)",
		"clip-path:inset(100%)",
		"overflow:hidden",
		"height:0",
		"max-height:0",
		"line-height:0",
		"font-size:7.99px",
		"font-size: .5px !important",
		"font-size:5pt",
		"font-size:10%",
		"margin:0 -12px 4px",
		"margin-block-start:-.5em",
		"margin-left:calc(1px - 50px)",
		"PoSiTiOn/**/: absolute",
		"\\64 isplay: none",
		"-webkit-transform:scale(0)",
		"-webkit-text-fill-color:transparent",
		"padding-left:9999px",
		"margin-left:9999px",
		"width:1px",
		"max-width:1px",
		"min-width:9999px",
		"letter-spacing:-20px",
		"word-spacing:-100px",
		"font-family:Wingdings",
		'font-family:Arial, "Wingdings", sans-serif',
		'font-family:"a;b", sans-serif',
		"-webkit-text-size-adjust:1%",
		"text-shadow:0 0 1px white",
		"-webkit-border-radius:4px",
		"line-height:1.4",
	])("R2: removes %s and keeps the surrounding declarations", (hostile) => {
		expect(agentStyle(`color: navy; ${hostile}; padding: 8px`)).toBe("color: navy; padding: 8px");
	});

	it("R2: keeps safe family lists, type sizes and spacing", () => {
		const safe =
			'font-family:Arial, "Times New Roman", sans-serif; font-size:8px; margin:0 2px 0 auto';
		expect(agentStyle(safe)).toBe(safe);
		expect(agentStyle("font-size:6pt; font-size:1rem")).toBe("font-size:6pt; font-size:1rem");
	});

	it("R2: a broken CSS string cannot smuggle a blocked declaration through", () => {
		expect(agentStyle('padding:8px; font-family:"a\n; display:none; z-index:999; x:"')).toBe(
			"padding:8px",
		);
	});
});
