/** Diff de linhas (LCS) com contexto curto, para mostrar ao usuário o que muda numa skill. */
export function lineDiff(before: string, after: string, context = 2): string[] {
  const a = before.split("\n"), b = after.split("\n");
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--)
    for (let j = b.length - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);

  const ops: { t: " " | "+" | "-"; s: string }[] = [];
  let i = 0, j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { ops.push({ t: " ", s: a[i] }); i++; j++; }
    else if (lcs[i + 1][j] >= lcs[i][j + 1]) ops.push({ t: "-", s: a[i++] });
    else ops.push({ t: "+", s: b[j++] });
  }
  while (i < a.length) ops.push({ t: "-", s: a[i++] });
  while (j < b.length) ops.push({ t: "+", s: b[j++] });

  if (ops.every((o) => o.t === " ")) return [];
  const keep = ops.map((o, k) => o.t !== " " || ops.slice(Math.max(0, k - context), k + context + 1).some((x) => x.t !== " "));
  const out: string[] = [];
  ops.forEach((o, k) => {
    if (keep[k]) out.push(`${o.t} ${o.s}`);
    else if (out[out.length - 1] !== "  …") out.push("  …");
  });
  return out;
}
