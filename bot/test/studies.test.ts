import { describe, expect, it } from "vitest";
import { clean, parseReport, toNumber } from "../src/studies.js";

const md = `# Title **bold**

Intro line one
continues here.

- first \`item\`
- second item
  continued

## Per day (UTC)

| Day | Liquidations | Gross bonus total (USD) |
|---|---:|---:|
| 2026-10-24 | 12 | $805 |
| 2026-10-25 | 4 | $3 |

Text after the table.

### Sub
`;

describe("parseReport", () => {
  const s = parseReport("x", "x.md", md);
  it("takes the title from the first heading", () => expect(s.title).toBe("Title bold"));
  it("parses paragraphs, lists (with continuation lines) and headings", () => {
    expect(s.blocks[0]).toEqual({ type: "text", text: "Intro line one continues here." });
    expect(s.blocks[1]).toEqual({ type: "list", items: ["first item", "second item continued"] });
    expect(s.blocks[2]).toEqual({ type: "heading", level: 2, text: "Per day (UTC)" });
    expect(s.blocks.at(-1)).toEqual({ type: "heading", level: 3, text: "Sub" });
  });
  it("parses tables exactly as written", () => {
    const t = s.blocks.find((b) => b.type === "table")!;
    expect(t).toEqual({ type: "table", columns: ["Day", "Liquidations", "Gross bonus total (USD)"], rows: [["2026-10-24", "12", "$805"], ["2026-10-25", "4", "$3"]] });
  });
  it("keeps the text that follows a table", () => {
    expect(s.blocks.some((b) => b.type === "text" && b.text === "Text after the table.")).toBe(true);
  });
});

describe("helpers", () => {
  it("clean removes markdown markers", () => expect(clean("a **b** `c`")).toBe("a b c"));
  it("toNumber", () => {
    expect(toNumber("$1,862")).toBe(1862);
    expect(toNumber("4.50%")).toBe(4.5);
    expect(Number.isNaN(toNumber("-"))).toBe(true);
  });
});
