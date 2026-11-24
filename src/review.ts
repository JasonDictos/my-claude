// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Plan review: an agent shows the user a plan over its pane; a passage the user selects and a
// question come back to the agent as a "[review] <path>:<lines>" block in its prompt.

// The window shows the plan rendered, so a selection has no Markdown in it: compare both
// sides without it.
const plain = (s: string) =>
  s.replace(/^\s*#+\s*/, "").replace(/^\s*(?:[-+*]|\d+\.)\s+/, "").replace(/[*_`]/g, "").replace(/\s+/g, " ").trim();

// The source lines (1-based, inclusive) a selection in the rendered plan came from; null when
// its first line is not in the source.
export function selectionLines(source: string, selection: string): [number, number] | null {
  const lines = source.split("\n").map(plain);
  const picked = selection.split("\n").map(plain).filter(Boolean);
  if (!picked.length) return null;
  const at = (text: string, from: number) => lines.findIndex((l, i) => i >= from && l.includes(text));
  const first = at(picked[0], 0);
  if (first < 0) return null;
  const last = picked.length > 1 ? at(picked[picked.length - 1], first) : first;
  return [first + 1, (last < 0 ? first : last) + 1];
}

export function reviewMessage(path: string, lines: [number, number] | null, selection: string, question: string): string {
  const where = !lines ? path : lines[0] === lines[1] ? `${path}:${lines[0]}` : `${path}:${lines[0]}-${lines[1]}`;
  return [`[review] ${where}`, ...selection.split("\n").map((l) => `> ${l}`), question].join("\n");
}
