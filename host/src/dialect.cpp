// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "dialect.h"
#include <QByteArrayList>
#include <cstring>

namespace {
const int kMaxCsi = 256;
const int kMaxOsc = 8 << 20; // a clipboard write can be large
}

void Dialect::reset() {
  state_ = Ground;
  seq_.clear();
  overflow_ = false;
}

QByteArray Dialect::feed(const QByteArray& in) {
  // An OSC, DCS or other string that never ends: tmux resets its parser after 5 seconds,
  // and what it shows from then on must be what we show.
  if (state_ >= Osc && since_.isValid() && since_.elapsed() > 5000) reset();
  QByteArray out;
  out.reserve(in.size() + 16);
  const char* p = in.constData();
  const char* const end = p + in.size();
  while (p < end) {
    if (state_ == Ground) {
      // Text: straight through, up to the next ESC. ENQ ("who is there?") is dropped.
      const char* e = static_cast<const char*>(memchr(p, 0x1b, size_t(end - p)));
      if (!e) e = end;
      for (const char* q; (q = static_cast<const char*>(memchr(p, 0x05, size_t(e - p)))); p = q + 1) out.append(p, q - p);
      out.append(p, e - p);
      p = e;
      if (p < end) { ++p; state_ = Esc; }
      continue;
    }
    const unsigned char c = static_cast<unsigned char>(*p++);
    switch (state_) {
    case Esc:
      switch (c) {
      case '[': seq_.clear(); overflow_ = false; state_ = Csi; break;
      case ']': seq_.clear(); overflow_ = false; since_.start(); state_ = Osc; break;
      case 'P': since_.start(); state_ = Dcs; break;                                  // DCS: tmux passthrough, sixel, capability queries
      case '_': case '^': case 'X': case 'k': since_.start(); state_ = Str; break;    // APC, PM, SOS, tmux's window name
      case 'Z': state_ = Ground; break;                                               // DECID: "what are you?"
      case 0x1b: out += '\x1b'; break;                                                // ESC ESC: one goes through, we are still after one
      default: out += '\x1b'; out += char(c); state_ = Ground; break;
      }
      break;
    case Csi:
      if (c >= 0x40 && c <= 0x7e) { csi(char(c), out); state_ = Ground; }
      else if (c >= 0x20 && c <= 0x3f) { if (seq_.size() < kMaxCsi) seq_ += char(c); else overflow_ = true; }
      else if (c == 0x1b) state_ = Esc;                 // cut short by a new sequence
      else if (c == 0x18 || c == 0x1a) state_ = Ground; // CAN, SUB: cancelled
      else if (c < 0x20) out += char(c);                // other controls act at once and the sequence goes on
      break;                                            // DEL and bytes above: ignored, as tmux does
    case Osc:
      if (c == 0x07) { osc(out); state_ = Ground; }
      else if (c == 0x1b) state_ = OscEsc;
      else if (c == 0x18 || c == 0x1a) state_ = Ground;
      else if (c >= 0x20) { if (seq_.size() < kMaxOsc) seq_ += char(c); else overflow_ = true; }
      break;
    case OscEsc: // an ESC ends the string, whatever follows; "\" is the rest of its terminator
      osc(out);
      if (c == '\\') state_ = Ground;
      else { state_ = Esc; --p; }
      break;
    case Dcs: // only ST ends a DCS: tmux's passthrough doubles the ESCs inside
      if (c == 0x1b) state_ = DcsEsc;
      break;
    case DcsEsc:
      state_ = c == '\\' ? Ground : Dcs;
      break;
    case Str:
      if (c == 0x1b) state_ = StrEsc;
      else if (c == 0x18 || c == 0x1a) state_ = Ground;
      break;
    case StrEsc:
      if (c == '\\') state_ = Ground;
      else { state_ = Esc; --p; }
      break;
    case Ground: break;
    }
  }
  return out;
}

void Dialect::csi(char f, QByteArray& out) {
  if (overflow_) return;
  const char lead = seq_.isEmpty() ? 0 : seq_.at(0);
  const bool priv = lead == '?' || lead == '>' || lead == '<' || lead == '=';
  switch (f) {
  case 'c': case 'n': case 'x': case 't': return; // what, where and how are you; window operations
  case 'p': if (seq_.contains('$')) return; break; // DECRQM: is this mode set?
  case 'q': if (lead == '>') return; break;        // XTVERSION
  case 'u': if (priv) return; break;               // keyboard protocol negotiation
  case 'S': if (lead == '?') return; break;        // graphics attributes
  case 'm':
    if (priv) return;                              // key modifier options, not colours
    if (seq_.contains(':') || seq_.contains("58") || seq_.contains("59")) {
      const QByteArray plain = sgr(seq_);
      if (!plain.isNull()) { out += "\x1b["; out += plain; out += 'm'; }
      return;
    }
    break;
  case 'h': case 'l':
    if (lead == '?' && mode) for (const QByteArray& n : seq_.mid(1).split(';')) if (n == "1004") mode(1004, f == 'h');
    break;
  default: break;
  }
  out += "\x1b[";
  out += seq_;
  out += f;
}

QByteArray Dialect::sgr(const QByteArray& params) {
  QByteArrayList out;
  const QByteArrayList groups = params.split(';');
  for (int i = 0; i < groups.size(); ++i) {
    const QByteArrayList sub = groups[i].split(':');
    const QByteArray head = sub.value(0);
    const bool colour = head == "38" || head == "48" || head == "58";
    if (sub.size() == 1) {
      if (colour) {
        // 38;5;n or 38;2;r;g;b: its numbers are not codes (58: an underline colour, dropped)
        const QByteArray kind = groups.value(i + 1);
        const int take = kind == "5" ? 3 : kind == "2" ? 5 : 1;
        if (head != "58") for (int k = 0; k < take && i + k < groups.size(); ++k) out << groups[i + k].split(':').value(0);
        i += take - 1;
      } else if (head != "59") out << head;
      continue;
    }
    if (head == "4") out << (sub[1] == "0" ? QByteArray("24") : QByteArray("4")); // underline styles: underlined or not
    else if (head == "58" || head == "59") continue;
    else if (colour && sub[1] == "5" && sub.size() >= 3) out << head << "5" << sub[2];
    else if (colour && sub[1] == "2" && sub.size() >= 5) {
      const int at = sub.size() >= 6 ? 3 : 2; // 38:2:r:g:b, or 38:2:<colour space>:r:g:b
      out << head << "2" << sub[at] << sub[at + 1] << sub[at + 2];
    } else if (!colour) out << head; // any other code: without its sub-parameters
  }
  return out.isEmpty() ? QByteArray() : (out.size() == 1 && out[0].isEmpty() ? QByteArray("0") : out.join(';'));
}

void Dialect::osc(QByteArray& out) {
  if (overflow_) return;
  const int semi = seq_.indexOf(';');
  bool ok = false;
  const int n = (semi < 0 ? seq_ : seq_.left(semi)).toInt(&ok);
  if (!ok) return;
  const QByteArray rest = semi < 0 ? QByteArray() : seq_.mid(semi + 1);
  switch (n) {
  case 0: case 1: case 2: // titles: the widget reports them
    out += "\x1b]";
    out += seq_;
    out += '\x07';
    return;
  case 52: { // 52;<which>;<base64>: the program copies text. "?" would be it reading the clipboard: never.
    const int s2 = rest.indexOf(';');
    const QByteArray data = s2 < 0 ? QByteArray() : rest.mid(s2 + 1);
    if (clipboard && !data.isEmpty() && data != "?") {
      const auto r = QByteArray::fromBase64Encoding(data);
      if (r) clipboard(*r);
    }
    return;
  }
  case 9: { // 9;<message>; ConEmu's 9;<1-12>;... are other things (progress, cwd)
    const int s2 = rest.indexOf(';');
    bool num = false;
    (s2 < 0 ? rest : rest.left(s2)).toInt(&num);
    if (notify && !num && !rest.isEmpty()) notify(QByteArray(), rest);
    return;
  }
  case 777: // 777;notify;<title>;<body>
    if (notify && rest.startsWith("notify;")) {
      const QByteArray tb = rest.mid(7);
      const int s2 = tb.indexOf(';');
      notify(s2 < 0 ? QByteArray() : tb.left(s2), s2 < 0 ? tb : tb.mid(s2 + 1));
    }
    return;
  default: return; // hyperlinks, colour queries and changes, prompt marks, cwd: not for the widget
  }
}
