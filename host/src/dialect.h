// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Between a tmux pane and the widget: tmux already answered the program's queries, so they are
// dropped (answered twice they read as typing), as are strings the widget cannot take.
#pragma once
#include <QByteArray>
#include <QElapsedTimer>
#include <functional>

class Dialect {
public:
  // Streaming: a sequence cut by the end of `in` waits for the rest of it.
  QByteArray feed(const QByteArray& in);
  void reset();
  std::function<void(const QByteArray& text)> clipboard;                        // OSC 52: the program copies text
  std::function<void(const QByteArray& title, const QByteArray& body)> notify;  // OSC 9, OSC 777
  std::function<void(int mode, bool on)> mode;                                  // private modes worth remembering
  // SGR parameters with colons or an underline colour, in the plain form; null: nothing left.
  static QByteArray sgr(const QByteArray& params);

private:
  enum State { Ground, Esc, Csi, Osc, OscEsc, Dcs, DcsEsc, Str, StrEsc };
  void csi(char final, QByteArray& out);
  void osc(QByteArray& out);
  State state_ = Ground;
  QByteArray seq_;       // a CSI's parameters and intermediates, or an OSC's text
  bool overflow_ = false;
  QElapsedTimer since_;  // when the string we are in began: like tmux, give up on it after 5 s
};
