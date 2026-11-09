// Prompt history and prediction candidates for the menu's text inputs.
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { ROOT, config } from "../store.ts";

const FILE = join(ROOT, ".history.json");
const CACHE = join(ROOT, ".cache", "repos.json");
const MAX = 50;

type Hist = Record<string, string[]>;

function readHist(): Hist {
  try {
    return JSON.parse(readFileSync(FILE, "utf8"));
  } catch {
    return {};
  }
}

export function history(key: string): string[] {
  return readHist()[key] ?? [];
}

export function remember(key: string, value: string): void {
  const v = value.trim();
  if (!v) return;
  const h = readHist();
  h[key] = [v, ...(h[key] ?? []).filter((x) => x !== v)].slice(0, MAX);
  writeFileSync(FILE + ".tmp", JSON.stringify(h, null, 2));
  renameSync(FILE + ".tmp", FILE);
}

// Git checkouts directly under ~, as "~/name".
function homeRepos(): string[] {
  const home = homedir();
  try {
    return readdirSync(home)
      .filter((n) => !n.startsWith(".") && existsSync(join(home, n, ".git")))
      .map((n) => `~/${n}`);
  } catch {
    return [];
  }
}

// Repo names of the default org, refreshed in the background at most daily.
let orgRepos: string[] | null = null;
function orgRepoNames(): string[] {
  if (orgRepos) return orgRepos;
  orgRepos = [];
  const org = config().clone?.defaultOrg as string | undefined;
  if (!org) return orgRepos;
  try {
    if (Date.now() - statSync(CACHE).mtimeMs < 86_400_000) {
      orgRepos = JSON.parse(readFileSync(CACHE, "utf8"));
      return orgRepos!;
    }
  } catch {
    /* no cache yet */
  }
  const proc = Bun.spawn(["gh", "repo", "list", org, "--limit", "1000", "--json", "name", "--jq", ".[].name"], { stdout: "pipe", stderr: "ignore" });
  new Response(proc.stdout).text().then((t) => {
    const names = t.split("\n").filter(Boolean).sort();
    if (names.length) {
      orgRepos = names;
      mkdirSync(join(ROOT, ".cache"), { recursive: true });
      writeFileSync(CACHE, JSON.stringify(names));
    }
  }).catch(() => {});
  return orgRepos ?? [];
}

export function candidates(key: string): string[] {
  const h = history(key);
  if (key !== "add") return h;
  // Specs only: drop flags and the values that follow them.
  const words = h.flatMap((l) => {
    const ws = l.split(/\s+/);
    return ws.filter((w, i) => !w.startsWith("--") && !(i > 0 && ws[i - 1].startsWith("--")));
  });
  return [...new Set([...words, ...homeRepos(), ...orgRepoNames()])];
}

// Ghost text for the word being typed: the remainder of the best candidate.
export function predict(value: string, cands: string[], wholeLine: boolean): string {
  const word = wholeLine ? value : value.split(/\s+/).pop() ?? "";
  if (!word) return "";
  const hit = cands.find((c) => c.startsWith(word) && c !== word);
  return hit ? hit.slice(word.length) : "";
}
