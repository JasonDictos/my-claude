// Terminal size for full-screen Ink views. Events alone proved unreliable in tmux
// (a pane resized before the listener existed stayed drawn at the old height), so
// the real size is also polled; `seq` changes on every size change and callers
// render it into the frame so Ink sees new output and redraws the whole screen.
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
