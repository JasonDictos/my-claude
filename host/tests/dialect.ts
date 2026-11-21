// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// src/dialect.h, bytes in and out: what passes, goes or is rewritten, also when a chunk
// boundary cuts a sequence anywhere.
// Run: bun host/tests/dialect.ts [path-to-mc-term]
const bin = process.argv[2] ?? new URL("../build/mc-term", import.meta.url).pathname;
const E = "\x1b";
const run = (input: string, chunk = 0) => {
  const r = Bun.spawnSync([bin, "--dialect", String(chunk)], { stdin: Buffer.from(input, "utf8"), stdout: "pipe", stderr: "pipe" });
  return { out: r.stdout.toString("utf8"), told: r.stderr.toString("utf8").trim() };
};
const show = (s: string) => JSON.stringify(s);
let bad = 0;
// [what, input, expected output, expected side lines]
const cases: [string, string, string, string?][] = [
  ["text", "hello\r\nworld\ttab", "hello\r\nworld\ttab"],
  ["utf-8", "çé✓ 日本語 🙂 ›", "çé✓ 日本語 🙂 ›"],
  ["colours", `${E}[1;31mred${E}[0m ${E}[38;5;196m${E}[48;2;1;2;3mx${E}[m`, `${E}[1;31mred${E}[0m ${E}[38;5;196m${E}[48;2;1;2;3mx${E}[m`],
  ["cursor moves, erases, modes", `${E}[2A${E}[10G${E}[2K${E}[J${E}[?25l${E}[?2004h${E}[?1049h${E}[2J${E}[3J${E}[H${E}[1;5r${E}7${E}8${E}M`, `${E}[2A${E}[10G${E}[2K${E}[J${E}[?25l${E}[?2004h${E}[?1049h${E}[2J${E}[3J${E}[H${E}[1;5r${E}7${E}8${E}M`],
  ["line drawing charset", `${E}(0lqqk${E}(B`, `${E}(0lqqk${E}(B`],
  ["synchronised output passes (the widget ignores it)", `${E}[?2026hx${E}[?2026l`, `${E}[?2026hx${E}[?2026l`],
  ["cursor shape passes", `${E}[5 q`, `${E}[5 q`],
  ["restore cursor (CSI u) passes", `${E}[s${E}[u`, `${E}[s${E}[u`],
  // queries: tmux answered, the widget must not
  ["what are you (DA1)", `a${E}[cb${E}[0cc`, "abc"],
  ["what are you (DA2, DA3)", `a${E}[>cb${E}[>0cc${E}[=cd`, "abcd"],
  ["status and cursor reports", `a${E}[5nb${E}[6nc${E}[?6nd`, "abcd"],
  ["DECID", `a${E}Zb`, "ab"],
  ["ENQ", "a\x05b\x05\x05c", "abc"],
  ["terminal parameters", `a${E}[xb${E}[1xc`, "abc"],
  ["is this mode set (DECRQM)", `a${E}[?2026$pb${E}[4$pc`, "abc"],
  ["terminal version", `a${E}[>0qb${E}[>qc`, "abc"],
  ["keyboard protocol", `a${E}[?ub${E}[>1uc${E}[<ud${E}[=1;1ue`, "abcde"],
  ["key modifier options", `a${E}[>4;2mb${E}[>4mc`, "abc"],
  ["window operations", `a${E}[8;24;80tb${E}[22;0;0tc${E}[18td`, "abcd"],
  // colours and underlines in the colon form
  ["curly underline", `${E}[4:3mx${E}[4:0m`, `${E}[4mx${E}[24m`],
  ["rgb with a colour space field", `${E}[38:2::255:0:10m`, `${E}[38;2;255;0;10m`],
  ["rgb without one", `${E}[48:2:1:2:3m`, `${E}[48;2;1;2;3m`],
  ["indexed", `${E}[38:5:196m`, `${E}[38;5;196m`],
  ["underline colour goes", `a${E}[58:2::1:2:3mb${E}[59mc`, "abc"],
  ["underline colour, old form", `${E}[1;58;5;196;4m${E}[58;2;1;2;3;3m`, `${E}[1;4m${E}[3m`],
  ["58 as a colour component is not an underline colour", `${E}[38;2;58;59;58m`, `${E}[38;2;58;59;58m`],
  ["mixed", `${E}[0;4:3;38:2::1:2:3;1m`, `${E}[0;4;38;2;1;2;3;1m`],
  // strings
  ["title", `${E}]0;hello world\x07${E}]2;two${E}\\`, `${E}]0;hello world\x07${E}]2;two\x07`],
  ["hyperlink wrappers go, the text stays", `${E}]8;;https://example.com/x${E}\\link${E}]8;;${E}\\!`, "link!"],
  ["colour queries and changes", `a${E}]11;?\x07b${E}]10;#ffffff\x07c${E}]4;1;?${E}\\d`, "abcd"],
  ["prompt marks, cwd", `a${E}]133;A\x07b${E}]7;file://h/p\x07c`, "abc"],
  ["clipboard write", `a${E}]52;c;aGVsbG8=\x07b`, "ab", "clipboard 68656c6c6f"],
  ["clipboard read is never answered or passed", `a${E}]52;c;?\x07b`, "ab", ""],
  ["notification (OSC 9)", `a${E}]9;Claude needs you\x07b`, "ab", "notify [] [Claude needs you]"],
  ["progress is not a notification", `a${E}]9;4;1;50\x07b`, "ab", ""],
  ["notification (OSC 777)", `a${E}]777;notify;Title;The body\x07b`, "ab", "notify [Title] [The body]"],
  ["capability query (DCS)", `a${E}P+q544e${E}\\b`, "ab"],
  ["tmux passthrough (DCS with doubled ESC)", `a${E}Ptmux;${E}${E}]9;hi\x07${E}\\b`, "ab"],
  ["graphics (APC)", `a${E}_Gf=100;AAAA${E}\\b`, "ab"],
  ["tmux window name", `a${E}kname${E}\\b`, "ab"],
  ["a string cut short by a new sequence", `a${E}kname${E}[1mb`, `a${E}[1mb`],
  ["a title cut short by a new sequence", `${E}]0;t${E}[1mx`, `${E}]0;t\x07${E}[1mx`],
  ["a control inside a sequence acts at once", `${E}[1\n;31mX`, `\n${E}[1;31mX`],
  ["CAN cancels a sequence", `${E}[12\x18X`, "X"],
  ["focus reporting is remembered", `${E}[?1004h${E}[?1004;2004l`, `${E}[?1004h${E}[?1004;2004l`, "mode 1004 1\nmode 1004 0"],
];
for (const [what, input, want, told] of cases) {
  const got = run(input);
  if (got.out !== want) { console.error(`FAIL ${what}\n  in   ${show(input)}\n  want ${show(want)}\n  got  ${show(got.out)}`); bad++; continue; }
  if (told !== undefined && got.told !== told) { console.error(`FAIL ${what}: told ${show(got.told)}, want ${show(told)}`); bad++; continue; }
  // cut anywhere, it must come out the same
  for (const chunk of [1, 2, 3, 5, 7]) {
    const cut = run(input, chunk);
    if (cut.out !== got.out || cut.told !== got.told) { console.error(`FAIL ${what}: differs when fed ${chunk} bytes at a time\n  whole ${show(got.out)}\n  cut   ${show(cut.out)}`); bad++; break; }
  }
}
// everything in one stream, and a megabyte of plain output untouched
const all = cases.map((c) => c[1]).join("plain text between\r\n");
const whole = run(all);
for (const chunk of [1, 4, 13, 4096]) if (run(all, chunk).out !== whole.out) { console.error(`FAIL: the whole stream differs at ${chunk} bytes a time`); bad++; }
const big = "0123456789 the quick brown fox ✓\r\n".repeat(30000);
const t0 = performance.now();
if (run(big, 65536).out !== big) { console.error("FAIL: plain output must pass untouched"); bad++; }
const ms = performance.now() - t0;
if (bad) process.exit(1);
console.log(`dialect OK (${cases.length} cases, ${(big.length / 1e6).toFixed(1)} MB of plain output through in ${ms.toFixed(0)} ms)`);
