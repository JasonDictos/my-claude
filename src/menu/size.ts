// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Terminal size for full-screen Ink views, also polled (a resize before the listener existed
// is missed); `seq`, rendered into the frame, makes Ink redraw everything.
import { useEffect, useState } from "react";

export interface TermSize { columns: number; rows: number; seq: number }

function read(): [number, number] {
  const ws = (process.stdout as { getWindowSize?: () => [number, number] }).getWindowSize?.();
  if (ws && ws[0] > 0 && ws[1] > 0) return ws;
  return [process.stdout.columns || 80, process.stdout.rows || 24];
}

export function useTermSize(): TermSize {
  const [size, setSize] = useState<TermSize>(() => {
    const [columns, rows] = read();
    return { columns, rows, seq: 0 };
  });
  useEffect(() => {
    const check = () => {
      const [columns, rows] = read();
      setSize((s) => (s.columns === columns && s.rows === rows ? s : { columns, rows, seq: s.seq + 1 }));
    };
    process.stdout.on("resize", check);
    const t = setInterval(check, 1000);
    return () => { process.stdout.off("resize", check); clearInterval(t); };
  }, []);
  return size;
}

// Invisible to the eye, different for odd and even `seq`: appended to a line so the
// frame text changes with the size and Ink rewrites it instead of skipping.
export const sizeMark = (seq: number) => (seq % 2 ? " " : "");
