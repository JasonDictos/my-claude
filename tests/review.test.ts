// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Plan review's pure parts: a selection in the rendered plan back to its source lines, and the
// block the agent gets.
import { expect, test } from "bun:test";
import { reviewMessage, selectionLines } from "../src/review.ts";

const src = "# Plan\n\n## Task 3: Reactors\n\n- One **reactor** per disk\n- `io_uring` engine\n\nDone.\n";
test("a plain line maps to itself", () => expect(selectionLines(src, "Done.")).toEqual([8, 8]));
test("formatting in the source does not hide it", () => expect(selectionLines(src, "One reactor per disk")).toEqual([5, 5]));
test("a selection over several lines spans them", () => expect(selectionLines(src, "Task 3: Reactors\nOne reactor per disk\nio_uring engine")).toEqual([3, 6]));
test("part of a line is that line", () => expect(selectionLines(src, "reactor per")).toEqual([5, 5]));
test("text that is not there has no lines", () => expect(selectionLines(src, "nowhere at all")).toBeNull());
test("the block the agent gets", () => expect(reviewMessage("docs/plan.md", [5, 6], "One reactor per disk\nio_uring engine", "why per disk?")).toBe("[review] docs/plan.md:5-6\n> One reactor per disk\n> io_uring engine\nwhy per disk?"));
test("one line, no range", () => expect(reviewMessage("docs/plan.md", [5, 5], "One reactor", "why?")).toBe("[review] docs/plan.md:5\n> One reactor\nwhy?"));
test("no lines found: the path alone", () => expect(reviewMessage("docs/plan.md", null, "x", "why?")).toBe("[review] docs/plan.md\n> x\nwhy?"));
