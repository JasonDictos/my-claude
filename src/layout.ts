// tmux layout strings, built by hand: a fixed column on the left for the side
// panel and a tiled grid of everything else. tmux's own `tiled` would absorb the
// panel into the grid. Format and checksum follow tmux's layout-custom.c.

export interface Cell { id: string; } // pane id, with or without the leading %

function checksum(s: string): string {
  let c = 0;
  for (const ch of s) {
    c = ((c >> 1) + ((c & 1) << 15)) & 0xffff;
    c = (c + ch.charCodeAt(0)) & 0xffff;
  }
  return c.toString(16).padStart(4, "0");
}

const num = (id: string) => id.replace(/^%/, "");

// Split `total` into `n` parts separated by 1-cell borders; the last part takes the remainder.
function parts(total: number, n: number): number[] {
  const usable = total - (n - 1);
  const each = Math.max(1, Math.floor(usable / n));
  const r: number[] = [];
  for (let i = 0; i < n; i++) r.push(i === n - 1 ? Math.max(1, usable - each * (n - 1)) : each);
  return r;
}

// Tile `ids` into a WxH region at (x, y): rows of nearly equal height, the last row
// stretching its (possibly fewer) panes.
function grid(ids: string[], w: number, h: number, x: number, y: number): string {
  if (ids.length === 1) return `${w}x${h},${x},${y},${num(ids[0])}`;
  const cols = Math.ceil(Math.sqrt(ids.length));
  const rows = Math.ceil(ids.length / cols);
  const heights = parts(h, rows);
  const rowStrs: string[] = [];
  let yy = y;
  for (let r = 0; r < rows; r++) {
    const slice = ids.slice(r * cols, (r + 1) * cols);
    const widths = parts(w, slice.length);
    if (slice.length === 1) rowStrs.push(`${w}x${heights[r]},${x},${yy},${num(slice[0])}`);
    else {
      let xx = x;
      const cells = slice.map((id, i) => {
        const s = `${widths[i]}x${heights[r]},${xx},${yy},${num(id)}`;
        xx += widths[i] + 1;
        return s;
      });
      rowStrs.push(`${w}x${heights[r]},${x},${yy}{${cells.join(",")}}`);
    }
    yy += heights[r] + 1;
  }
  return rows === 1 ? rowStrs[0] : `${w}x${h},${x},${y}[${rowStrs.join(",")}]`;
}

// The whole window: `panel` (if any) as a `panelWidth` column on the left, `cells` tiled to its right.
export function layout(width: number, height: number, panel: string | null, cells: string[], panelWidth = 30): string | null {
  if (cells.length === 0 && !panel) return null;
  let body: string;
  if (!panel) body = grid(cells, width, height, 0, 0);
  else if (cells.length === 0) body = `${width}x${height},0,0,${num(panel)}`;
  else {
    const pw = Math.min(panelWidth, Math.max(10, width - 20));
    const rest = width - pw - 1;
    body = `${width}x${height},0,0{${pw}x${height},0,0,${num(panel)},${grid(cells, rest, height, pw + 1, 0)}}`;
  }
  return `${checksum(body)},${body}`;
}
