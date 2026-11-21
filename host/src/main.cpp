// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "dialect.h"
#include "host.h"
#include "theme.h"
#include <QApplication>
#include <QTimer>
#include <QCommandLineParser>
#include <QDir>
#include <QCoreApplication>
#include <QFileInfo>
#include <QFile>
#include <QDirIterator>
#include <QIcon>
#include <QLocalSocket>
#include <QRegularExpression>
#include <QStandardPaths>
#include <csignal>
#include <cstdio>
#include <cstdlib>
#include <cstring>

// mc-term --dialect [chunk]: stdin through the pane-output adapter to stdout, cut into
// chunks of that many bytes; what it hands its owner goes to stderr. For tests.
static int dialectFilter(int chunk) {
  Dialect d;
  d.clipboard = [](const QByteArray& t) { fprintf(stderr, "clipboard %s\n", t.toHex().constData()); };
  d.notify = [](const QByteArray& t, const QByteArray& b) { fprintf(stderr, "notify [%s] [%s]\n", t.constData(), b.constData()); };
  d.mode = [](int m, bool on) { fprintf(stderr, "mode %d %d\n", m, on ? 1 : 0); };
  QByteArray all;
  char buf[65536];
  for (size_t n; (n = fread(buf, 1, sizeof buf, stdin)) > 0;) all.append(buf, qsizetype(n));
  QByteArray out;
  if (chunk <= 0) out = d.feed(all);
  else for (qsizetype i = 0; i < all.size(); i += chunk) out += d.feed(all.mid(i, chunk));
  fwrite(out.constData(), 1, size_t(out.size()), stdout);
  return 0;
}

int main(int argc, char** argv) {
  if (argc >= 2 && !strcmp(argv[1], "--dialect")) return dialectFilter(argc >= 3 ? atoi(argv[2]) : 0);
  // QProcess learns of child exits through SIGCHLD; a launcher that blocks it would hand
  // us that mask, and every terminal would look alive forever.
  sigset_t none;
  sigemptyset(&none);
  sigprocmask(SIG_SETMASK, &none, nullptr);
  // Started from inside tmux, every terminal here would inherit $TMUX and tmux refuses to nest.
  qunsetenv("TMUX");
  qunsetenv("TMUX_PANE");

#ifdef MC_STATIC
  // the keyboard layouts and colour schemes qtermwidget reads, unpacked from the binary
  // once per version; QTERMWIDGET_DATA_DIR points it there (packaging/static)
  {
    QCoreApplication probe(argc, argv); // QStandardPaths and resources need an instance
    const QString dir = QStandardPaths::writableLocation(QStandardPaths::GenericCacheLocation) + "/my-claude/qtermwidget-" + QT_VERSION_STR;
    if (!QDir(dir + "/kb-layouts").exists()) {
      QDirIterator it(":/qtw", QDirIterator::Subdirectories);
      while (it.hasNext()) {
        const QString f = it.next();
        if (QFileInfo(f).isDir()) continue;
        const QString to = dir + f.mid(QString(":/qtw").size());
        QDir().mkpath(QFileInfo(to).path());
        QFile::copy(f, to);
      }
    }
    qputenv("QTERMWIDGET_DATA_DIR", dir.toLocal8Bit());
  }
#endif
  QApplication app(argc, argv);
  app.setApplicationName("mc-term");
  app.setApplicationDisplayName("my-claude");
  app.setDesktopFileName("mc-term"); // Wayland takes the taskbar icon from the .desktop file
  {
    // scalable, with pixel versions for the small sizes
    QIcon icon(":/mc-term.svg");
    for (const int n : {16, 32, 64, 256}) icon.addFile(QString(":/mc-term-%1.png").arg(n), QSize(n, n));
    app.setWindowIcon(icon);
  }
  if (!qEnvironmentVariableIsSet("MC_TERM_SYSTEM_THEME")) theme::applyChrome(app);
  QCommandLineParser p;
  p.setApplicationDescription("my-claude's native window: tabs and tiled terminals driven over a Unix socket");
  p.addHelpOption();
  QCommandLineOption sock({"s", "socket"}, "Socket path (default $MC_TERM_SOCKET or $XDG_RUNTIME_DIR/my-claude/host.sock)", "path");
  QCommandLineOption driver({"d", "driver"}, "Command that drives the window (default $MC_TERM_DRIVER); started here and restarted when it dies", "command");
  QCommandLineOption remote({"r", "remote"}, "Show another machine's projects: the window runs here, my-claude and tmux run there, all of it over one ssh connection", "user@host");
  QCommandLineOption remoteCmd("remote-command", "What starts my-claude's driver there", "command", "my-claude _gui");
  QCommandLineOption port({"p", "port"}, "ssh port there (e.g. my-claude's own daemon)", "port");
  QCommandLineOption identity({"i", "identity"}, "ssh private key to log in with", "file");
  QCommandLineOption jump({"J", "jump"}, "reach it through this ssh host (ssh -J)", "host");
  p.addOption(sock);
  p.addOption(driver);
  p.addOption(remote);
  p.addOption(remoteCmd);
  p.addOption(port);
  p.addOption(identity);
  p.addOption(jump);
  p.process(app);
  const QString dest = p.value(remote);
  const QString run = QStandardPaths::writableLocation(QStandardPaths::RuntimeLocation);
  QDir().mkpath(run + "/my-claude");
  QString path = p.value(sock);
  if (path.isEmpty() && dest.isEmpty()) path = qEnvironmentVariable("MC_TERM_SOCKET");
  if (path.isEmpty()) {
    // a window of its own for each machine, beside the one for this machine
    QString tag = dest;
    tag.replace(QRegularExpression("[^A-Za-z0-9_.-]"), "_");
    path = run + "/my-claude/" + (dest.isEmpty() ? QString("host") : "remote-" + tag) + ".sock";
  }
  QString cmd = p.value(driver);
  if (cmd.isEmpty()) cmd = qEnvironmentVariable("MC_TERM_DRIVER");

  // One window per socket: a second start raises the first and leaves.
  {
    QLocalSocket probe;
    probe.connectToServer(path);
    if (probe.waitForConnected(400)) {
      probe.write("{\"op\":\"raise\"}\n");
      probe.waitForBytesWritten(400);
      probe.disconnectFromServer();
      return 0;
    }
  }
  Host w(path, dest.isEmpty() ? cmd : QString());
  if (!dest.isEmpty()) {
    // one multiplexed ssh connection (sshd or the daemon's endpoint) for the driver there,
    // on its stdio, and a tmux control client per session shown
    const QString ssh = qEnvironmentVariable("MC_TERM_SSH", "ssh");
    QStringList base = {ssh, "-T", "-o", "ControlMaster=auto", "-o", "ControlPath=" + run + "/my-claude/ssh-%C", "-o", "ControlPersist=60",
                        "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3", "-o", "Compression=yes"};
    if (p.isSet(port)) base << "-p" << p.value(port);
    if (p.isSet(identity)) base << "-i" << p.value(identity) << "-o" << "IdentitiesOnly=yes";
    if (p.isSet(jump)) base << "-J" << p.value(jump);
    // In a login shell with the per-user install places on PATH; exactly REMOTE_PATH of
    // src/remote.ts, which the far side's gate expects.
    const QString driverThere = "bash -lc 'export PATH=\"$HOME/.local/bin:$HOME/.bun/bin:$PATH\"; exec " + p.value(remoteCmd) + " --stdio'";
    w.setRemote(dest, base + QStringList{dest, driverThere}, base + QStringList{dest, "tmux"});
  }
  if (!w.restoredGeometry()) w.resize(1500, 950); // first run: a size worth a grid of terminals
  // shown once the driver has filled it in (Host::revealFirst), or after 4 s whatever it has
  if (cmd.isEmpty() && dest.isEmpty()) w.show();
  else QTimer::singleShot(4000, &w, [&w] { QMetaObject::invokeMethod(&w, "revealFirstSlot"); });
  return app.exec();
}
