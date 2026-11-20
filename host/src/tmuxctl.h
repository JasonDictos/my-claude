// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// The window as the real terminal of tmux panes, through a control-mode client (tmux -C);
// tmux still owns the processes, so closing the window ends nothing.
#pragma once
#include <QByteArray>
#include <QList>
#include <QObject>
#include <QProcessEnvironment>
#include <QSet>
#include <QString>
#include <QStringList>
#include <functional>

class Feed;
class QProcess;
class QSocketNotifier;

// One control client per tmux session: commands in, replies and pane output out.
class TmuxControl : public QObject {
  Q_OBJECT
public:
  // A command's reply: %end (ok) or %error, and the lines in between.
  using Reply = std::function<void(bool ok, const QList<QByteArray>& lines)>;
  // `tmux`: how tmux is run, {"tmux"} here, or through ssh for a session on another machine.
  TmuxControl(const QString& session, const QProcessEnvironment& env, const QStringList& tmux, QObject* parent = nullptr);
  ~TmuxControl() override;
  const QString& session() const { return session_; }
  bool running() const { return running_; }
  // One command (no ";": tmux answers each command of a list separately, and a failed one
  // cancels the rest of its list, which would lose count of the answers).
  void command(const QString& line, Reply done = {});
  // Several commands that must run back to back: written in one piece, tmux queues them
  // together and runs them before it reads anything else. One answer per command.
  struct Block { bool ok = false; QList<QByteArray> lines; };
  void batch(const QStringList& lines, std::function<void(const QList<Block>&)> done);
  // the display is behind: stop reading, tmux stops reading the pane, the program waits as
  // on a real terminal (nothing dropped, nothing piled up)
  void setThrottled(bool on);
  // Only the panes somebody shows are worth decoding.
  void show(const QString& pane, bool on);
  // What the terminal emulator produced for the user's keys, byte for byte.
  void sendKeys(const QString& pane, const QByteArray& bytes);
  static QString quote(const QString& s);

signals:
  void output(const QString& pane, const QByteArray& data); // what the pane's program wrote
  void paused(const QString& pane); // tmux stopped sending a pane's output (we fell too far behind, or asked)
  void exited(const QString& reason);

private:
  void readyRead();
  void handleLine(const QByteArray& line);
  void finish(const QString& reason);
  QString session_;
  QProcess* proc_ = nullptr;
  // tmux's stdin and stdout are pipes of our own, not QProcess's: reading must be ours
  // to stop (QProcess reads its child's output without limit).
  int in_ = -1, out_ = -1;
  QSocketNotifier* readable_ = nullptr;
  Feed* toTmux_ = nullptr;
  QByteArray buf_;
  QList<Reply> pending_; // one per command line sent, in order
  QList<QByteArray> block_;
  QSet<QByteArray> shown_;
  QByteArray blockNum_;
  bool inBlock_ = false, mine_ = false, running_ = false, throttled_ = false;
};

// Bytes into a terminal widget's pty without ever blocking the GUI thread: what does not
// fit now waits for the pty to drain. `pending()` is what the owner throttles on.
class Feed : public QObject {
  Q_OBJECT
public:
  Feed(int fd, QObject* parent = nullptr);
  void write(const QByteArray& data);
  qint64 pending() const { return size_; }

signals:
  void drained(); // everything written

private:
  void flush();
  int fd_;
  QList<QByteArray> chunks_;
  qint64 off_ = 0, size_ = 0;
  QSocketNotifier* notifier_ = nullptr;
};
