export function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } | null {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return null;
  const meta: Record<string, string> = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([\w-]+):\s*(.*)$/);
    if (kv) meta[kv[1]] = kv[2].trim();
  }
  return { meta, body: m[2] };
}

export function stringifyFrontmatter(meta: Record<string, string | number>, body: string): string {
  const head = Object.entries(meta).map(([k, v]) => `${k}: ${String(v).replace(/\s*\n\s*/g, " ")}`).join("\n");
  return `---\n${head}\n---\n${body.trim()}\n`;
}
