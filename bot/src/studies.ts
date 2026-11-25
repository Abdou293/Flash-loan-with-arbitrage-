/**
 * Turns the measurement reports in docs/reports/*.md (real, read-only runs) into JSON for the dashboard.
 * Pure parsing: no numbers are typed in by hand and nothing is recomputed, so what the dashboard shows is exactly
 * what the report says.
 */
export type Block =
  | { type: "heading"; level: number; text: string }
  | { type: "text"; text: string }
  | { type: "list"; items: string[] }
  | { type: "table"; columns: string[]; rows: string[][] };

export interface Study {
  id: string;
  title: string;
  /** file in docs/reports this was parsed from */
  source: string;
  blocks: Block[];
}

/** Plain text for display: the dashboard never uses innerHTML, so markdown markers are simply removed. */
export function clean(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

const splitRow = (line: string): string[] =>
  line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => clean(c));

const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function parseReport(id: string, source: string, markdown: string): Study {
  const lines = markdown.split("\n");
  const blocks: Block[] = [];
  let title = id;
  let para: string[] = [];
  let list: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ type: "text", text: clean(para.join(" ")) });
    if (list.length) blocks.push({ type: "list", items: list.map(clean) });
    para = [];
    list = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const h = /^(#{1,4})\s+(.*)$/.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      const text = clean(h[2]!);
      if (level === 1) title = text;
      else blocks.push({ type: "heading", level, text });
      continue;
    }
    if (line.trim().startsWith("|") && i + 1 < lines.length && isSeparator(lines[i + 1]!)) {
      flush();
      const columns = splitRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i]!.trim().startsWith("|")) {
        rows.push(splitRow(lines[i]!));
        i++;
      }
      i--;
      blocks.push({ type: "table", columns, rows });
      continue;
    }
    const b = /^\s*(?:[-*]|\d+\.)\s+(.*)$/.exec(line);
    if (b) {
      if (para.length) {
        blocks.push({ type: "text", text: clean(para.join(" ")) });
        para = [];
      }
      list.push(b[1]!);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    // continuation of a list item (indented) or of a paragraph
    if (list.length && /^\s{2,}\S/.test(line)) list[list.length - 1] += " " + line.trim();
    else {
      if (list.length) {
        blocks.push({ type: "list", items: list.map(clean) });
        list = [];
      }
      para.push(line.trim());
    }
  }
  flush();
  return { id, title, source, blocks };
}

/** "$1,862" -> 1862, "4.50%" -> 4.5, anything else -> NaN */
export const toNumber = (s: string): number => Number(s.replace(/[$,%\s]/g, "").replace(/^-$/, "NaN"));
