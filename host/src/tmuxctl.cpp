// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "tmuxctl.h"
#include <QProcess>
#include <QSocketNotifier>
#include <QTimer>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <unistd.h>

TmuxControl::TmuxControl(const QString& session, const QProcessEnvironment& env, const QStringList& tmux, QObject* parent) : QObject(parent), session_(session) {
  int toChild[2] = {-1, -1}, fromChild[2] = {-1, -1};
  if (::pipe2(toChild, O_CLOEXEC) != 0 || ::pipe2(fromChild, O_CLOEXEC) != 0) qFatal("mc-term: pipe: %s", strerror(errno));
  proc_ = new QProcess(this);
  proc_->setProcessEnvironment(env);
  // Nothing of QProcess's on the child's stdio: the modifier puts our pipes there.
  proc_->setInputChannelMode(QProcess::ForwardedInputChannel);
  proc_->setProcessChannelMode(QProcess::ForwardedChannels);
  const int childIn = toChild[0], childOut = fromChild[1];
  proc_->setChildProcessModifier([childIn, childOut] { ::dup2(childIn, 0); ::dup2(childOut, 1); });
  connect(proc_, &QProcess::finished, this, [this](int, QProcess::ExitStatus) { readyRead(); finish("tmux control client ended"); });
  connect(proc_, &QProcess::errorOccurred, this, [this](QProcess::ProcessError e) { if (e == QProcess::FailedToStart) finish("tmux did not start"); });
  running_ = true;
  proc_->start(tmux.value(0, "tmux"), tmux.mid(1) + QStringList{"-C", "attach-session", "-t", "=" + session});
  ::close(childIn);
  ::close(childOut);
  in_ = toChild[1];
  out_ = fromChild[0];
  ::fcntl(in_, F_SETFL, ::fcntl(in_, F_GETFL) | O_NONBLOCK);
  ::fcntl(out_, F_SETFL, ::fcntl(out_, F_GETFL) | O_NONBLOCK);
  toTmux_ = new Feed(in_, this);
  readable_ = new QSocketNotifier(out_, QSocketNotifier::Read, this);
  connect(readable_, &QSocketNotifier::activated, this, [this] { readyRead(); });
  // no size announced (we size windows ourselves); a hung window must not hold the programs:
  // seconds behind, tmux lets the pane run on (%pause) and it is read again later
  command("refresh-client -f pause-after=5");
}

TmuxControl::~TmuxControl() {
  running_ = false;
  if (readable_) readable_->setEnabled(false);
  delete toTmux_; // its notifier watches in_
  toTmux_ = nullptr;
  if (in_ >= 0) ::close(in_); // EOF on a control client's stdin detaches it
  if (proc_->state() != QProcess::NotRunning) {
    // it outlives us until it has exited (stdin closed: it detaches); the GUI thread never waits
    QProcess* p = proc_;
    p->disconnect(this);
    p->setParent(nullptr);
    QObject::connect(p, &QProcess::finished, p, &QObject::deleteLater);
    QTimer::singleShot(300, p, [p] { if (p->state() != QProcess::NotRunning) p->kill(); });
  }
  if (out_ >= 0) ::close(out_);
}

void TmuxControl::finish(const QString& reason) {
  if (!running_) return;
  running_ = false;
  // Nobody will answer what is still waiting.
  const auto waiting = pending_;
  pending_.clear();
  for (const Reply& r : waiting) if (r) r(false, {});
  emit exited(reason);
}

QString TmuxControl::quote(const QString& s) {
  QString q = s;
  q.replace("'", "'\\''");
  return "'" + q + "'";
}

void TmuxControl::command(const QString& line, Reply done) {
  if (!running_) { if (done) done(false, {}); return; }
  pending_ << done;
  toTmux_->write(line.toUtf8() + "\n");
}

void TmuxControl::batch(const QStringList& lines, std::function<void(const QList<Block>&)> done) {
  if (lines.isEmpty()) return;
  if (!running_) { if (done) done({}); return; }
  auto acc = std::make_shared<QList<Block>>();
  const int n = lines.size();
  for (int i = 0; i < n; ++i) {
    pending_ << [acc, n, done](bool ok, const QList<QByteArray>& out) {
      acc->append(Block{ok, out});
      if (acc->size() == n && done) done(*acc);
    };
  }
  toTmux_->write(lines.join('\n').toUtf8() + "\n");
}

void TmuxControl::show(const QString& pane, bool on) {
  if (on) shown_.insert(pane.toLatin1());
  else shown_.remove(pane.toLatin1());
}

void TmuxControl::sendKeys(const QString& pane, const QByteArray& bytes) {
  static const char hex[] = "0123456789abcdef";
  for (int i = 0; i < bytes.size(); i += 512) {
    QByteArray cmd = "send-keys -t " + pane.toLatin1() + " -H";
    const int end = qMin<int>(bytes.size(), i + 512);
    for (int k = i; k < end; ++k) {
      const unsigned char c = static_cast<unsigned char>(bytes[k]);
      cmd += ' ';
      cmd += hex[c >> 4];
      cmd += hex[c & 15];
    }
    command(QString::fromLatin1(cmd));
  }
}

void TmuxControl::setThrottled(bool on) {
  if (throttled_ == on) return;
  throttled_ = on;
  if (readable_) readable_->setEnabled(!on);
  if (!on) QMetaObject::invokeMethod(this, [this] { readyRead(); }, Qt::QueuedConnection);
}

void TmuxControl::readyRead() {
  // Lines are handled one at a time so that a terminal falling behind can stop us
  // mid-buffer; what is left waits here and, beyond that, in the pipe.
  char chunk[65536];
  for (;;) {
    int from = 0;
    for (int nl = buf_.indexOf('\n', from); nl >= 0 && !throttled_ && running_; nl = buf_.indexOf('\n', from)) {
      handleLine(buf_.mid(from, nl - from));
      from = nl + 1;
    }
    buf_.remove(0, from);
    if (throttled_ || !running_ || out_ < 0) return;
    const ssize_t n = ::read(out_, chunk, sizeof chunk);
    if (n > 0) { buf_.append(chunk, int(n)); continue; }
    if (n < 0 && errno == EINTR) continue;
    if (n == 0) { readable_->setEnabled(false); finish("tmux control client ended"); }
    return; // EAGAIN: nothing more for now
  }
}

// %output data: bytes under 0x20 and the backslash come as \ooo.
static QByteArray unescape(const QByteArray& in) {
  QByteArray out;
  out.reserve(in.size());
  const char* p = in.constData();
  const char* end = p + in.size();
  while (p < end) {
    if (*p == '\\' && end - p >= 4 && p[1] >= '0' && p[1] <= '3' && p[2] >= '0' && p[2] <= '7' && p[3] >= '0' && p[3] <= '7') {
      out += char(((p[1] - '0') << 6) | ((p[2] - '0') << 3) | (p[3] - '0'));
      p += 4;
    } else out += *p++;
  }
  return out;
}

void TmuxControl::handleLine(const QByteArray& l) {
  if (inBlock_) {
    // A block ends with %end or %error carrying its %begin's number; anything else in
    // between is the command's output, whatever it looks like.
    if ((l.startsWith("%end ") || l.startsWith("%error ")) && l.split(' ').value(2) == blockNum_) {
      inBlock_ = false;
      const bool ok = l.startsWith("%end ");
      const QList<QByteArray> lines = block_;
      block_.clear();
      if (mine_ && !pending_.isEmpty()) {
        const Reply r = pending_.takeFirst();
        if (r) r(ok, lines);
      }
      return;
    }
    block_ << l;
    return;
  }
  if (l.startsWith("%output ")) {
    const int sp = l.indexOf(' ', 8);
    if (sp > 0 && shown_.contains(l.mid(8, sp - 8))) emit output(QString::fromLatin1(l.mid(8, sp - 8)), unescape(l.mid(sp + 1)));
    return;
  }
  if (l.startsWith("%begin ")) {
    const QList<QByteArray> parts = l.split(' ');
    blockNum_ = parts.value(2);
    mine_ = parts.value(3).toInt() & 1; // flags bit 0: a command of this client
    inBlock_ = true;
    block_.clear();
    return;
  }
  if (l.startsWith("%extended-output ")) { // %extended-output %pane age ... : data
    const int sp = l.indexOf(' ', 17);
    const int colon = l.indexOf(" : ", sp);
    if (sp > 0 && colon > 0 && shown_.contains(l.mid(17, sp - 17))) emit output(QString::fromLatin1(l.mid(17, sp - 17)), unescape(l.mid(colon + 3)));
    return;
  }
  if (l.startsWith("%pause ")) { emit paused(QString::fromLatin1(l.mid(7).trimmed())); return; }
  if (l.startsWith("%exit")) { finish(l.size() > 6 ? QString::fromUtf8(l.mid(6)) : QString("the tmux session ended")); return; }
}

Feed::Feed(int fd, QObject* parent) : QObject(parent), fd_(fd) {
  notifier_ = new QSocketNotifier(fd, QSocketNotifier::Write, this);
  notifier_->setEnabled(false);
  connect(notifier_, &QSocketNotifier::activated, this, [this] { flush(); });
}

void Feed::write(const QByteArray& data) {
  if (data.isEmpty()) return;
  chunks_ << data;
  size_ += data.size();
  if (!notifier_->isEnabled()) flush();
}

void Feed::flush() {
  while (!chunks_.isEmpty()) {
    const QByteArray& c = chunks_.first();
    const ssize_t n = ::write(fd_, c.constData() + off_, size_t(c.size() - off_));
    if (n > 0) {
      off_ += n;
      size_ -= n;
      if (off_ == c.size()) { chunks_.removeFirst(); off_ = 0; }
      continue;
    }
    if (n < 0 && errno == EINTR) continue;
    if (n < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) { notifier_->setEnabled(true); return; }
    chunks_.clear(); // the pty is gone
    size_ = 0;
    off_ = 0;
  }
  notifier_->setEnabled(false);
  emit drained();
}
