// One color per project, used by the menu and the tmux status bar alike. Picked
// at creation (or changed later); a project without one gets a stable default
// derived from its name.
export const PALETTE: Record<string, { ink: string; tmux: string }> = {
  blue: { ink: "#5fafff", tmux: "colour75" },
  orange: { ink: "#ff8700", tmux: "colour208" },
  green: { ink: "#87d787", tmux: "colour114" },
  purple: { ink: "#af87ff", tmux: "colour141" },
  red: { ink: "#ff5f5f", tmux: "colour203" },
  yellow: { ink: "#ffd700", tmux: "colour220" },
  teal: { ink: "#5fd7d7", tmux: "colour80" },
  pink: { ink: "#ff87d7", tmux: "colour212" },
};
export const COLOR_NAMES = Object.keys(PALETTE);
// The handful offered when creating a project.
export const COLOR_CHOICES = ["blue", "orange", "green", "purple", "red"];

export function projectColor(name: string, chosen?: string | null): { ink: string; tmux: string } {
  if (chosen && PALETTE[chosen]) return PALETTE[chosen];
  let h = 0;
  for (const c of name) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return PALETTE[COLOR_NAMES[h % COLOR_NAMES.length]];
}
