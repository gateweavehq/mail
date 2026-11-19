const FORMATTING = new Set([
	"color",
	"background-color",
	"font-weight",
	"font-style",
	"text-align",
	"text-decoration",
	"vertical-align",
	"border-collapse",
	"border-spacing",
	"border-radius",
	"list-style-type",
	"white-space",
]);

const BORDER =
	/^border(?:-(?:top|right|bottom|left))?(?:-(?:color|style|width))?$|^border-(?:top|bottom)-(?:left|right)-radius$/;
const SPACING =
	/^(?:margin|padding)(?:-(?:top|right|bottom|left|(?:block|inline)(?:-start|-end)?))?$/;
const WIDTH_TAGS = new Set(["table", "td", "th", "img"]);
const FONT_FAMILIES = new Set([
	"serif",
	"sans-serif",
	"monospace",
	"system-ui",
	"arial",
	"helvetica",
	"georgia",
	"times new roman",
	"verdana",
	"tahoma",
	"trebuchet ms",
	"courier new",
	"segoe ui",
	"roboto",
]);

/** Read semicolons only outside strings, comments and functions. Escapes never go back out. */
function* declarations(style: string): Generator<string> {
	let start = 0;
	let depth = 0;
	for (const token of style.matchAll(
		/"(?:[^"\r\n\f\\]|\\[\s\S])*"|'(?:[^'\r\n\f\\]|\\[\s\S])*'|\/\*[\s\S]*?\*\/|\\[\s\S]|\/\*|["'();]/g,
	)) {
		switch (token[0]) {
			case '"':
			case "'":
			case "/*":
				return;
			case "(":
				depth++;
				break;
			case ")":
				depth--;
				if (depth < 0) return;
				break;
			case ";":
				if (depth !== 0) break;
				yield style.slice(start, token.index);
				start = token.index + 1;
				break;
		}
	}
	if (depth === 0) yield style.slice(start);
}

const DIMENSION = /^(\+?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)([a-z]+|%)$/i;
const FONT_KEYWORD = /^(?:small|medium|large|x-large|xx-large|xxx-large|larger)$/i;
const MIN_FONT_SIZE: Record<string, number> = {
	px: 8,
	pt: 6,
	pc: 0.5,
	in: 8 / 96,
	cm: (8 * 2.54) / 96,
	mm: (8 * 25.4) / 96,
	q: (8 * 101.6) / 96,
	em: 1,
	rem: 1,
	"%": 100,
};

function readableSize(value: string): boolean {
	if (FONT_KEYWORD.test(value)) return true;
	const size = DIMENSION.exec(value.toLowerCase());
	const minimum = size?.[2] && MIN_FONT_SIZE[size[2]];
	return typeof minimum === "number" && Number(size?.[1]) >= minimum;
}

function commonFamilies(value: string): boolean {
	return value.split(",").every((family) => {
		const name = family.trim().toLowerCase();
		const quoted = /^(?:"([^"]*)"|'([^']*)')$/.exec(name);
		return FONT_FAMILIES.has(quoted?.[1] ?? quoted?.[2] ?? name.replace(/\s+/g, " "));
	});
}

// Keep ordinary spacing units and leave out lengths large enough to push the mail off-screen.
const MAX_SPACING: Record<string, number> = {
	px: 1000,
	pt: 750,
	pc: 62.5,
	in: 1000 / 96,
	cm: (1000 * 2.54) / 96,
	mm: (1000 * 25.4) / 96,
	q: (1000 * 101.6) / 96,
	em: 64,
	rem: 64,
	"%": 100,
};

function ordinarySpacing(value: string, margin: boolean): boolean {
	const parts = value.toLowerCase().split(/\s+/);
	return (
		parts.length <= 4 &&
		parts.every((part) => {
			if (/^\+?0(?:\.0+)?$/.test(part) || (margin && part === "auto")) return true;
			const size = DIMENSION.exec(part);
			const maximum = size?.[2] && MAX_SPACING[size[2]];
			return typeof maximum === "number" && Number(size?.[1]) <= maximum;
		})
	);
}

function keepDeclaration(property: string, value: string, tag: string): boolean {
	if (FORMATTING.has(property) || BORDER.test(property)) return true;
	if (property === "font-size") return readableSize(value);
	if (property === "font-family") return commonFamilies(value);
	if (property === "width" || property === "max-width") return WIDTH_TAGS.has(tag);
	return SPACING.test(property) && ordinarySpacing(value, property.startsWith("margin"));
}

/** A style attribute already decoded from HTML, keeping declarations that cannot hide the line. */
export function agentStyle(style: string, tag = "div"): string {
	const kept: string[] = [];
	for (const declaration of declarations(style)) {
		if (declaration.includes("\\")) continue;
		const colon = declaration.indexOf(":");
		if (colon < 0) continue;
		const property = declaration
			.slice(0, colon)
			.replace(/\/\*[\s\S]*?\*\//g, " ")
			.trim()
			.toLowerCase();
		const value = declaration
			.slice(colon + 1)
			.replace(/"[^"]*"|'[^']*'|(\/\*[\s\S]*?\*\/)/g, (token, comment) => (comment ? " " : token))
			.replace(/!\s*important\s*$/i, "")
			.trim();
		if (!value || !keepDeclaration(property, value, tag)) continue;
		kept.push(declaration.trim());
	}
	return kept.join("; ");
}
