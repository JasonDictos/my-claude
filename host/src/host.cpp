// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "host.h"
#include "dialect.h"
#include "form.h"
#include "theme.h"
#include "tmuxctl.h"
#include <QAction>
#include <QApplication>
#include <QClipboard>
#include <QGraphicsOpacityEffect>
#include <QPropertyAnimation>
#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusMetaType>
#include <QCloseEvent>
#include <QDateTime>
#include <QDesktopServices>
#include <QDir>
#include <QDockWidget>
#include <QFontDatabase>
#include <QFontMetricsF>
#include <QFrame>
#include <QHBoxLayout>
#include <QHeaderView>
#include <QJsonDocument>
#include <QKeyEvent>
#include <QLocalServer>
#include <QLocalSocket>
#include <QMenu>
#include <QMenuBar>
#include <QPainter>
#include <QProcess>
#include <QRandomGenerator>
#include <QScrollBar>
#include <QSettings>
#include <QSplitter>
#include <QStackedWidget>
#include <QStandardPaths>
#include <QStatusBar>
#include <QTabBar>
#include <QTabWidget>
#include <QTest>
#include <QTimer>
#include <QStyle>
#include <QToolButton>
#include <QTreeWidget>
#include <QVBoxLayout>
#include <QtMath>
#include <fcntl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <termios.h>
#include <unistd.h>
#include <wchar.h>
#include <qtermwidget.h>
#ifdef MC_HAVE_XCB
#include <xcb/xcb.h>
#endif

namespace {
const char* kPlaceholder = "No project open.\n\nPick one in the Projects list (Enter or double-click starts it),\nor use my-claude → New project.";

// The state mark in front of a sidebar entry: a filled dot, a half, a ring or a bang.
QIcon dotIcon(const QString& shape, const QColor& color) {
  if (shape.isEmpty() || shape == "none") return QIcon();
  QPixmap pm(32, 32);
  pm.fill(Qt::transparent);
  QPainter p(&pm);
  p.setRenderHint(QPainter::Antialiasing);
  const QRectF r(7, 7, 18, 18);
  p.setPen(QPen(color, 4));
  if (shape == "full") {
    p.setBrush(color);
    p.drawEllipse(r);
  } else if (shape == "half") {
    p.setBrush(Qt::NoBrush);
    p.drawEllipse(r);
    p.setPen(Qt::NoPen);
    p.setBrush(color);
    p.drawPie(r, 90 * 16, 180 * 16);
  } else if (shape == "bang") {
    QFont f = p.font();
    f.setBold(true);
    f.setPixelSize(28);
    p.setFont(f);
    p.drawText(pm.rect(), Qt::AlignCenter, "!");
  } else {
    p.setBrush(Qt::NoBrush);
    p.drawEllipse(r);
  }
  return QIcon(pm);
}

bool statePersisted() { return !qEnvironmentVariableIsSet("MC_TERM_NO_STATE"); }

// Keys this widget encodes differently from tmux, rewritten as tmux would send them: programs
// in a pane were written against tmux's encoding.
QByteArray tmuxKeys(const QByteArray& b) {
  if (b == "\x1b[H" || b == "\x1bOH") return "\x1b[1~";
  if (b == "\x1b[F" || b == "\x1bOF") return "\x1b[4~";
  if (b == "\x1bOM") return "\n";
  if (b.size() == 4 && b.startsWith("\x1bO") && b[2] >= '2' && b[2] <= '8' && b[3] >= 'P' && b[3] <= 'S') return QByteArray("\x1b[1;") + b[2] + b[3];
  return b;
}
} // namespace

namespace {
// "febe", "febe/%3", "p:febe", "r:febe/repo", "t:febe/%3": the project part gets "@tag"
QString tagName(const QString& s, const QString& tag) {
  if (s.isEmpty()) return s;
  const int colon = (s.size() > 2 && s[1] == ':') ? 2 : 0;
  const int slash = s.indexOf('/', colon);
  const int end = slash < 0 ? s.size() : slash;
  return s.left(end) + "@" + tag + s.mid(end);
}
// the reverse, or null when the name is not that machine's
QString untagName(const QString& s, const QString& tag) {
  const QString at = "@" + tag;
  const int colon = (s.size() > 2 && s[1] == ':') ? 2 : 0;
  const int slash = s.indexOf('/', colon);
  const int end = slash < 0 ? s.size() : slash;
  if (!s.left(end).endsWith(at)) return QString();
  return s.left(end - at.size()) + s.mid(end);
}
// the machine a name belongs to ("" for this one's)
QString tagOf(const QString& s) {
  const int colon = (s.size() > 2 && s[1] == ':') ? 2 : 0;
  const int slash = s.indexOf('/', colon);
  const QString project = s.mid(colon, (slash < 0 ? s.size() : slash) - colon);
  const int at = project.lastIndexOf('@');
  return at < 0 ? QString() : project.mid(at + 1);
}
QJsonArray tagTree(const QJsonArray& nodes, const QString& tag, bool top) {
  QJsonArray out;
  for (const auto& v : nodes) {
    QJsonObject n = v.toObject();
    n["id"] = tagName(n.value("id").toString(), tag);
    if (top) n["label"] = n.value("label").toString() + "@" + tag;
    if (n.contains("children")) n["children"] = tagTree(n.value("children").toArray(), tag, false);
    out << n;
  }
  return out;
}
} // namespace

void TermHook::onUrl(const QUrl& url, bool) { QDesktopServices::openUrl(url); }

void Header::mousePressEvent(QMouseEvent* e) {
  if (e->button() == Qt::LeftButton) emit pressed();
  QLabel::mousePressEvent(e);
}
void Header::mouseDoubleClickEvent(QMouseEvent* e) {
  if (e->button() == Qt::LeftButton) emit doubleClicked();
}
void Header::contextMenuEvent(QContextMenuEvent* e) { emit menuRequested(e->globalPos()); }

Host::Host(const QString& socketPath, const QString& driverCmd, QWidget* parent)
    : QMainWindow(parent), socketPath_(socketPath), driverCmd_(driverCmd) {
  setWindowTitle("my-claude");
  setObjectName("mc-term");
  clock_.start();
  // an alpha channel from the start (it cannot be added once on screen), for see-through
  // terminals; everything else paints itself solid
  setAttribute(Qt::WA_TranslucentBackground);

  // The font starts as what qterminal is set up with (the same widget, so it renders the
  // same); the `font` request overrides. Colours are our own (theme.h) unless a scheme is named.
  QSettings qt(QDir::homePath() + "/.config/qterminal.org/qterminal.ini", QSettings::IniFormat);
  font_ = qt.value("fontFamily").toString();
  fontSize_ = baseFontSize_ = qt.value("fontSize", fontSize_).toInt();

  center_ = new QStackedWidget(this);
  placeholder_ = new QLabel(kPlaceholder, center_);
  placeholder_->setObjectName("placeholder");
  placeholder_->setAlignment(Qt::AlignCenter);
  tabs_ = new QTabWidget(center_);
  tabs_->setDocumentMode(true);
  tabs_->setMovable(false);
  tabs_->setTabsClosable(true);
  center_->addWidget(placeholder_);
  center_->addWidget(tabs_);
  setCentralWidget(center_);
  connect(tabs_, &QTabWidget::currentChanged, this, [this](int i) {
    if (i < 0) { setWindowTitle(remote_.isEmpty() ? QString("my-claude") : "my-claude @ " + remote_); return; }
    const QString name = tabName(i);
    setWindowTitle(name + " — my-claude" + (remote_.isEmpty() ? QString() : " @ " + remote_));
    // the line under the current tab takes its project's colour
    if (const Tab* cur = tabOf(name)) if (!cur->color.isEmpty()) tabs_->tabBar()->setStyleSheet(QString("QTabBar::tab:selected { border-bottom: 2px solid %1; }").arg(QColor(cur->color).name()));
    emitEvent({{"ev", "tab"}, {"tab", name}});
    if (!tree_->hasFocus()) {
      // the list follows the tab: its project is the one marked there
      for (int k = 0; k < tree_->topLevelItemCount(); ++k)
        if (tree_->topLevelItem(k)->text(0) == name) { tree_->blockSignals(true); tree_->setCurrentItem(tree_->topLevelItem(k)); tree_->blockSignals(false); break; }
      focusCurrent();
    }
  });
  connect(tabs_, &QTabWidget::tabCloseRequested, this, [this](int i) { emitEvent({{"ev", "tab-close"}, {"tab", tabName(i)}}); });

  dock_ = new QDockWidget("Projects", this);
  dock_->setObjectName("projects");
  dock_->setFeatures(QDockWidget::DockWidgetMovable | QDockWidget::DockWidgetClosable);
  // a plain caption instead of a title bar with float and close buttons (View shows and hides the list)
  auto* caption = new QLabel("PROJECTS", dock_);
  caption->setObjectName("docktitle");
  dock_->setTitleBarWidget(caption);
  caption->setContextMenuPolicy(Qt::CustomContextMenu);
  connect(caption, &QWidget::customContextMenuRequested, this, [this, caption](const QPoint& p) { QMenu* m = createPopupMenu(); m->exec(caption->mapToGlobal(p)); m->deleteLater(); });
  tree_ = new QTreeWidget(dock_);
  tree_->setColumnCount(2);
  tree_->setHeaderHidden(true);
  tree_->setIndentation(14);
  tree_->setUniformRowHeights(true);
  tree_->setExpandsOnDoubleClick(false);
  tree_->header()->setStretchLastSection(false);
  tree_->header()->setSectionResizeMode(0, QHeaderView::Stretch);
  tree_->header()->setSectionResizeMode(1, QHeaderView::ResizeToContents);
  tree_->setContextMenuPolicy(Qt::CustomContextMenu);
  tree_->installEventFilter(this);
  dock_->setWidget(tree_);
  addDockWidget(Qt::LeftDockWidgetArea, dock_);
  connect(tree_, &QTreeWidget::itemClicked, this, [this](QTreeWidgetItem* it, int) {
    emitEvent({{"ev", "select"}, {"node", it->data(0, Qt::UserRole).toString()}});
  });
  connect(tree_, &QTreeWidget::itemDoubleClicked, this, [this](QTreeWidgetItem* it, int) {
    emitEvent({{"ev", "activate"}, {"node", it->data(0, Qt::UserRole).toString()}});
  });
  connect(tree_, &QTreeWidget::currentItemChanged, this, [this](QTreeWidgetItem* it, QTreeWidgetItem*) {
    // walking the list brings what it points at on screen; the keyboard stays in the list
    // until Enter, Esc or a click
    if (!it || !tree_->hasFocus()) return;
    const QString node = it->data(0, Qt::UserRole).toString();
    for (const Term& t : terms_) if (t.node == node) { reveal(t.id); return; }
    if (!it->parent()) if (Tab* tab = tabOf(it->text(0))) tabs_->setCurrentWidget(tab->page);
  });
  connect(tree_, &QTreeWidget::itemCollapsed, this, [this](QTreeWidgetItem* it) { collapsed_.insert(it->data(0, Qt::UserRole).toString()); });
  connect(tree_, &QTreeWidget::itemExpanded, this, [this](QTreeWidgetItem* it) { collapsed_.remove(it->data(0, Qt::UserRole).toString()); });
  connect(tree_, &QTreeWidget::customContextMenuRequested, this, [this](const QPoint& p) {
    if (QTreeWidgetItem* it = tree_->itemAt(p)) showNodeMenu(it->data(0, Qt::UserRole).toString(), tree_->viewport()->mapToGlobal(p), QString());
  });

  busyLabel_ = new QLabel(this);
  driverLabel_ = new QLabel(this);
  statusBar()->setSizeGripEnabled(false);
  statusBar()->addPermanentWidget(busyLabel_);
  statusBar()->addPermanentWidget(driverLabel_);

  // Enough of a menu to get around, and out, before a driver says what the real one is.
  setMenus(QJsonArray{QJsonObject{{"title", "&my-claude"}, {"items", QJsonArray{
    QJsonObject{{"id", "host.sidebar"}, {"label", "Project list"}, {"shortcuts", QJsonArray{"Ctrl+`", "Ctrl+Shift+D"}}},
    QJsonObject{{"id", "host.tab-next"}, {"label", "Next project"}, {"shortcut", "Ctrl+Tab"}},
    QJsonObject{{"id", "host.pane-next"}, {"label", "Next pane"}, {"shortcut", "Ctrl+Shift+Tab"}},
    QJsonObject{{"separator", true}},
    QJsonObject{{"id", "host.quit"}, {"label", "Quit"}, {"shortcut", "Ctrl+Shift+Q"}}}}}});

  QLocalServer::removeServer(socketPath_);
  server_ = new QLocalServer(this);
  if (!server_->listen(socketPath_)) qFatal("mc-term: cannot listen on %s: %s", qPrintable(socketPath_), qPrintable(server_->errorString()));
  connect(server_, &QLocalServer::newConnection, this, &Host::onConnection);

  if (statePersisted()) {
    QSettings st("my-claude", "mc-term");
    restored_ = restoreGeometry(st.value("geometry").toByteArray());
    restoreState(st.value("state").toByteArray());
    fontSize_ = st.value("fontSize", fontSize_).toInt();
    menuPersist_ = st.value("menuPersist", true).toBool();
    if (!menuPersist_) QTimer::singleShot(0, this, [this] { menuBar()->hide(); });
  }
  // Unlimited scrollback is file-backed, and the files go where TMPDIR says. /tmp is RAM
  // here (tmpfs), which would defeat the point: the cache directory is on disk.
  hadTmpDir_ = qEnvironmentVariableIsSet("TMPDIR");
  origTmpDir_ = qEnvironmentVariable("TMPDIR");
  const QString sb = QStandardPaths::writableLocation(QStandardPaths::GenericCacheLocation) + "/my-claude/scrollback";
  if (QDir().mkpath(sb)) qputenv("TMPDIR", sb.toLocal8Bit());
  auto* guard = new QTimer(this);
  guard->setInterval(30000);
  connect(guard, &QTimer::timeout, this, &Host::guardScrollback);
  guard->start();
  if (qEnvironmentVariableIsSet("MC_TERM_DEBUG_TIMERS")) {
    auto* dbg = new QTimer(this);
    dbg->setInterval(500);
    connect(dbg, &QTimer::timeout, this, [this] {
      for (const Term& t : terms_) {
        const QScrollBar* bar = t.widget->findChild<QScrollBar*>();
        fprintf(stderr, "view %s (%s) @%lld: scrollbar %d of %d, history %d, updates %d\n", qPrintable(t.id), qPrintable(t.title), clock_.elapsed(), bar ? bar->value() : -1, bar ? bar->maximum() : -1, t.widget->historyLinesCount(), t.widget->updatesEnabled());
      }
    });
    dbg->start();
  }

  // The shortcut bar: terminal text over the bottom of the window. Holding Alt for a
  // moment (or F1) brings it up; it stays 30 s, then fades.
  keyBar_ = new QLabel(this);
  keyBar_->setObjectName("keybar");
  keyBar_->setWordWrap(true);
  keyBar_->setTextFormat(Qt::RichText);
  keyBar_->setAttribute(Qt::WA_TransparentForMouseEvents);
  keyBar_->hide();
  f1Hold_ = new QTimer(this);
  f1Hold_->setSingleShot(true);
  f1Hold_->setInterval(450);
  connect(f1Hold_, &QTimer::timeout, this, [this] { f1Held_ = true; showKeyBar(); showBadges(); });
  // Alt held: the menu bar, when it is set to stay hidden; it goes again a few seconds
  // after Alt is let go, unless a menu is open.
  altTimer_ = new QTimer(this);
  altTimer_->setSingleShot(true);
  altTimer_->setInterval(qEnvironmentVariableIntValue("MC_TERM_ALT_HOLD_MS") > 0 ? qEnvironmentVariableIntValue("MC_TERM_ALT_HOLD_MS") : 350);
  connect(altTimer_, &QTimer::timeout, this, [this] { if (!menuPersist_) { menuHide_->stop(); menuBar()->show(); } });
  menuHide_ = new QTimer(this);
  menuHide_->setSingleShot(true);
  menuHide_->setInterval(4000);
  connect(menuHide_, &QTimer::timeout, this, [this] {
    if (menuPersist_) return;
    if (menuBar()->activeAction()) { menuHide_->start(); return; } // a menu is open: later
    menuBar()->hide();
  });
  keyBarTimer_ = new QTimer(this);
  keyBarTimer_->setSingleShot(true);
  keyBarTimer_->setInterval(30000);
  connect(keyBarTimer_, &QTimer::timeout, this, &Host::hideKeyBar);
  qApp->installEventFilter(this);
  updateCenter();
  applyTransparency();
  // after main() has said whether this window is for another machine (setRemote)
  if (!qEnvironmentVariableIsSet("MC_TERM_TEST") && qEnvironmentVariable("QT_QPA_PLATFORM") != "offscreen") QTimer::singleShot(0, this, &Host::registerGlobalKey);
  center_->setFocus(); // not the sidebar: the first pane to open takes the keyboard
  if (driverCmd_.isEmpty()) driverLabel_->setText("no driver");
  else QTimer::singleShot(0, this, &Host::startDriver);
}

// The server deletes its sockets after our members are gone; their disconnected handlers
// must not run into a destroyed clients_ then.
Host::~Host() {
  for (QLocalSocket* s : clients_) s->disconnect(this);
  clients_.clear();
  for (Machine& mc : machines_) if (mc.driver) mc.driver->disconnect(this);
}

void Host::closeEvent(QCloseEvent* e) {
  quitting_ = true;
  if (statePersisted()) {
    QSettings st("my-claude", "mc-term");
    st.setValue("geometry", saveGeometry());
    st.setValue("state", saveState());
    st.setValue("fontSize", fontSize_);
  }
  emitEvent({{"ev", "quit"}});
  // other machines' drivers end with the window (their projects run on there); their
  // exit handlers must not run into a window that is going away
  for (Machine& mc : machines_) {
    mc.wanted = false;
    if (!mc.driver) continue;
    mc.driver->disconnect(this);
    mc.driver->terminate();
    if (!mc.driver->waitForFinished(1500)) mc.driver->kill();
  }
  if (driver_ && driver_->state() != QProcess::NotRunning) {
    driver_->terminate();
    if (!driver_->waitForFinished(1500)) driver_->kill();
  }
  e->accept();
}

// ---- driver --------------------------------------------------------------------------

void Host::startDriver() {
  if (quitting_ || driverCmd_.isEmpty()) return;
  driver_ = new QProcess(this);
  driver_->setProcessEnvironment(childEnv());
  const QString dir = QStandardPaths::writableLocation(QStandardPaths::GenericCacheLocation) + "/my-claude";
  QDir().mkpath(dir);
  driver_->setStandardOutputFile(dir + "/gui-driver.log", QIODevice::Append);
  driver_->setStandardErrorFile(dir + "/gui-driver.log", QIODevice::Append);
  connect(driver_, &QProcess::finished, this, [this](int, QProcess::ExitStatus) { driverExited(); });
  connect(driver_, &QProcess::errorOccurred, this, [this](QProcess::ProcessError err) {
    if (err == QProcess::FailedToStart) { driverLabel_->setText("driver did not start: " + driverCmd_); driverExited(); }
  });
  driverStarts_ << QDateTime::currentMSecsSinceEpoch();
  driverLabel_->setText(QString());
  if (driverArgv_.isEmpty()) { driver_->startCommand(driverCmd_); return; }
  // a remote driver speaks on its stdio: bridged to a connection to our own socket, it is a
  // driver like any other
  driver_->setStandardOutputFile(QString());
  driver_->setReadChannel(QProcess::StandardOutput);
  auto* bridge = new QLocalSocket(driver_);
  QProcess* d = driver_;
  connect(d, &QProcess::readyReadStandardOutput, bridge, [d, bridge] { bridge->write(d->readAllStandardOutput()); });
  connect(bridge, &QLocalSocket::readyRead, d, [d, bridge] { d->write(bridge->readAll()); });
  // connected before the driver starts: its first words must not be lost
  bridge->connectToServer(socketPath_);
  bridge->waitForConnected(2000);
  driver_->start(driverArgv_.first(), driverArgv_.mid(1));
}

void Host::setRemote(const QString& name, const QStringList& driverArgv, const QStringList& tmux) {
  remote_ = name;
  driverArgv_ = driverArgv;
  driverCmd_ = "ssh " + name;
  tmuxCmd_ = tmux;
  setWindowTitle("my-claude @ " + name);
  placeholder_->setText("Connecting to " + name + "…");
  QTimer::singleShot(0, this, &Host::startDriver);
}

// A driver that dies comes back, the terminals never noticing. One that dies five times
// in a minute is broken, and says so instead of spinning.
void Host::driverExited() {
  if (driver_) { driver_->deleteLater(); driver_ = nullptr; }
  if (quitting_) return;
  const qint64 now = QDateTime::currentMSecsSinceEpoch();
  while (!driverStarts_.isEmpty() && now - driverStarts_.first() > 60000) driverStarts_.removeFirst();
  if (driverStarts_.size() >= 5) {
    driverLabel_->setText("driver keeps failing (~/.cache/my-claude/gui-driver.log); my-claude → Restart driver");
    return;
  }
  driverLabel_->setText("driver restarting…");
  QTimer::singleShot(400 * driverStarts_.size(), this, &Host::startDriver);
}

// ---- socket --------------------------------------------------------------------------

void Host::onConnection() {
  while (QLocalSocket* s = server_->nextPendingConnection()) {
    clients_.insert(s);
    connect(s, &QLocalSocket::readyRead, this, [this, s] { onReadyRead(s); });
    connect(s, &QLocalSocket::disconnected, this, [this, s] {
      clients_.remove(s);
      buffers_.remove(s);
      if (driverSock_ == s) driverSock_ = nullptr;
      clientTag_.remove(s);
      s->deleteLater();
    });
    reply(s, {{"ev", "hello"}, {"version", 2}, {"terminals", int(terms_.size())}});
  }
}

void Host::onReadyRead(QLocalSocket* s) {
  QByteArray& buf = buffers_[s];
  buf += s->readAll();
  for (int nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
    const QByteArray line = buf.left(nl).trimmed();
    buf.remove(0, nl + 1);
    if (line.isEmpty()) continue;
    QJsonParseError err;
    const QJsonDocument doc = QJsonDocument::fromJson(line, &err);
    if (!doc.isObject()) { reply(s, {{"ev", "error"}, {"error", "bad json: " + err.errorString()}}); continue; }
    QJsonObject msg = doc.object();
    if (msg.value("op").toString() == "iam") { clientTag_[s] = msg.value("machine").toString(); continue; }
    const QString tag = clientTag_.value(s);
    if (!tag.isEmpty()) {
      // another machine's driver: its names tagged; what is the window's own (menus,
      // settings, the look) stays this machine's to say
      static const QSet<QString> windowOwn{"menu", "settings", "look", "font", "scheme", "placeholder", "tabs", "driver", "quit", "globalKey", "connect", "disconnect"};
      const QString op = msg.value("op").toString();
      if (op == "tree") { machines_[tag].tree = tagIn(msg, tag).value("nodes").toArray(); machines_[tag].state = "up"; machines_[tag].restarts = 0; rebuildTree(); continue; }
      if (op == "busy") { if (!msg.value("text").toString().isEmpty()) statusBar()->showMessage(tag + ": " + msg.value("text").toString(), 5000); continue; }
      if (op == "notify") { QJsonObject n = msg; n["text"] = tag + ": " + msg.value("text").toString(); handle(n, s); continue; }
      if (windowOwn.contains(op)) continue;
      msg = tagIn(msg, tag);
      if (op == "ask") msg["id"] = msg.value("id").toString() + "#" + tag;
    }
    handle(msg, s);
    if (!clients_.contains(s)) return; // a request may end the connection
  }
}

void Host::reply(QLocalSocket* to, const QJsonObject& msg) {
  if (!to || to->state() != QLocalSocket::ConnectedState) return;
  to->write(QJsonDocument(msg).toJson(QJsonDocument::Compact) + "\n");
  to->flush(); // events must not wait for the loop: a crash right after would lose them
}

void Host::emitEvent(const QJsonObject& ev) {
  // What the user does while the driver is away (it is restarting) is kept for it: a
  // click must not vanish because it landed in that half second.
  static const QSet<QString> user{"action", "activate", "select", "tab-close", "settings", "settings-open", "nudge"};
  if (!driverSock_ && !driverCmd_.isEmpty() && user.contains(ev.value("ev").toString()) && held_.size() < 64) held_ << ev;
  const auto all = clients_; // a handler may drop a client while we write
  for (QLocalSocket* s : all) {
    QJsonObject out;
    QJsonObject e = ev;
    // a dialog a machine's driver opened: its own id back
    const QString tag = clientTag_.value(s);
    if (e.value("ev").toString() == "answer" && e.value("id").toString().contains('#')) {
      if (e.value("id").toString().section('#', 1) != tag) continue;
      e["id"] = e.value("id").toString().section('#', 0, 0);
      reply(s, e);
      continue;
    }
    if (routeEvent(e, tag, &out)) reply(s, out);
  }
}

void Host::handle(const QJsonObject& m, QLocalSocket* from) {
  const QString op = m.value("op").toString();
  const QString id = m.value("id").toString();
  const auto noTerm = [&] { reply(from, {{"ev", "error"}, {"error", "no terminal " + id}}); };
  if (op == "ping") { reply(from, {{"ev", "pong"}}); return; }
  if (op == "driver") {
    // A (new) driver: questions its predecessor left open have nobody to answer to, and
    // what the user did meanwhile is its to handle.
    driverSock_ = from;
    driverLabel_->setText(QString());
    // the driver has said what there is (tabs, panes, the tree): the window may show now
    QTimer::singleShot(250, this, [this] { revealFirst(); });
    const auto open = asks_;
    for (auto it = open.begin(); it != open.end(); ++it) if (it.key() != "settings") it.value()->reject();
    const auto held = held_;
    held_.clear();
    for (const QJsonObject& ev : held) reply(from, ev);
    return;
  }
  if (op == "open") { open(m); return; }
  if (op == "close") { closeTerm(id, false); return; }
  if (op == "focus") { focusTerm(id); return; }
  if (op == "connect") { // another machine's projects in this window
    const QString tag = m.value("machine").toString();
    if (tag.isEmpty() || tag.contains('/') || tag.contains('|')) { reply(from, {{"ev", "error"}, {"error", "bad machine name"}}); return; }
    Machine mc;
    mc.tag = tag;
    for (const auto& v : m.value("driver").toArray()) mc.driverArgv << v.toString();
    for (const auto& v : m.value("tmux").toArray()) mc.tmux << v.toString();
    if (machines_.contains(tag)) stopMachine(tag);
    machines_.insert(tag, mc);
    startMachine(tag);
    return;
  }
  if (op == "disconnect") { stopMachine(m.value("machine").toString()); return; }
  if (op == "globalKey") { // the show/hide key, set from Settings: taken over live
    toggleKey_ = m.value("keys").toString();
    if (!qEnvironmentVariableIsSet("MC_TERM_TEST")) registerGlobalKey();
    return;
  }
  if (op == "toggle") {
    // drop-down style: up front and full screen, or out of the way
    if (!m.value("show").toBool() && isVisible() && isActiveWindow() && !(windowState() & Qt::WindowMinimized)) { hide(); return; }
    showInFront();
    return;
  }
  if (op == "raise") { show(); setWindowState(windowState() & ~Qt::WindowMinimized); raise(); activateWindow(); return; }
  if (op == "quit") { close(); qApp->quit(); return; } // quit even when hidden (closing a hidden window ends nothing)
  if (op == "emit") { emitEvent(m.value("event").toObject()); return; }
  if (op == "send") { if (terms_.contains(id)) terms_[id].widget->sendText(m.value("text").toString()); else noTerm(); return; }
  if (op == "font") {
    if (m.contains("family")) font_ = m.value("family").toString();
    if (m.contains("size")) fontSize_ = baseFontSize_ = m.value("size").toInt(fontSize_);
    applyFont();
    return;
  }
  if (op == "look") {
    if (m.contains("scrollback")) scrollback_ = m.value("scrollback").toInt(-1) == 0 ? -1 : m.value("scrollback").toInt(-1);
    if (m.contains("copyOnSelect")) copyOnSelect_ = m.value("copyOnSelect").toBool(true);
    if (m.contains("scrollbackCapGB")) scrollbackCap_ = qint64(qMax(1.0, m.value("scrollbackCapGB").toDouble(20))) << 30;
    if (m.contains("clipboardFromPrograms")) clipboardFromPrograms_ = m.value("clipboardFromPrograms").toBool(true);
    if (m.contains("menuPersist")) setMenuPersist(m.value("menuPersist").toBool(true));
    if (m.contains("seedLines")) seedLines_ = qBound(0, m.value("seedLines").toInt(50000), 2000000);
    if (m.contains("perGroup")) { perGroup_ = qBound(1, m.value("perGroup").toInt(4), 16); for (Tab& t : tabsByName_) retile(t); }
    if (m.contains("scheme")) scheme_ = m.value("scheme").toString();
    if (m.contains("tint")) tint_ = qBound(0.0, m.value("tint").toDouble(35) / 100.0, 1.0);
    if (m.contains("alternate")) alternate_ = m.value("alternate").toBool(true);
    if (m.contains("transparency")) transparency_ = qBound(0.0, m.value("transparency").toDouble(0) / 100.0, 0.95);
    if (m.contains("blur")) blur_ = m.value("blur").toBool(true);
    if (m.contains("transparency") || m.contains("blur")) applyTransparency();
    if (m.contains("scheme") || m.contains("tint") || m.contains("alternate")) {
      for (Tab& t : tabsByName_) retile(t);
      for (auto& t : terms_) applyTheme(t);
    }
    return;
  }
  if (op == "scheme") { // a named colour scheme; empty: ours
    scheme_ = m.value("name").toString();
    for (auto& t : terms_) applyTheme(t);
    return;
  }
  if (op == "set" || op == "title" || op == "color" || op == "attention") {
    if (!terms_.contains(id)) { noTerm(); return; }
    Term& t = terms_[id];
    if (m.contains("title")) t.title = m.value("title").toString();
    if (m.contains("color")) t.color = m.value("color").toString();
    if (m.contains("attention")) t.attention = m.value("attention").toString();
    if (m.contains("scheme")) { t.ownScheme = m.value("scheme").toString(); applyTheme(t); }
    if (m.contains("textStep") && m.value("textStep").toInt() != t.textStep) setTextStep(t, m.value("textStep").toInt(), false);
    if (m.contains("node")) {
      t.node = m.value("node").toString();
      if (activeId_ == id && !tree_->hasFocus()) if (QTreeWidgetItem* it = nodeItems_.value(t.node)) { tree_->blockSignals(true); tree_->setCurrentItem(it); tree_->blockSignals(false); }
    }
    paintHeader(t);
    if (Tab* tab = tabOf(t.tab)) { paintTab(*tab); if (t.minimised) retile(*tab); }
    return;
  }
  if (op == "order") {
    Tab* tab = tabOf(m.value("tab").toString());
    if (!tab) return;
    QStringList next;
    for (const auto& v : m.value("ids").toArray()) if (tab->order.contains(v.toString()) && !next.contains(v.toString())) next << v.toString();
    for (const QString& have : tab->order) if (!next.contains(have)) next << have;
    if (next != tab->order) { tab->order = next; retile(*tab); }
    return;
  }
  if (op == "tab") {
    if (m.contains("cycle")) { cycleTab(m.value("cycle").toInt(1)); return; }
    const QString name = m.value("tab").toString();
    if (m.value("close").toBool()) { closeTab(name); return; }
    Tab* t = tabOf(name);
    if (!t) return;
    if (m.contains("color")) {
      t->color = m.value("color").toString();
      for (const QString& tid : t->order) if (terms_.contains(tid)) { applyTheme(terms_[tid]); paintHeader(terms_[tid]); }
    }
    paintTab(*t);
    if (m.value("focus").toBool()) { tabs_->setCurrentWidget(t->page); focusCurrent(); }
    return;
  }
  if (op == "tabs") {
    int at = 0;
    for (const auto& v : m.value("order").toArray()) {
      Tab* t = tabOf(v.toString());
      if (!t) continue;
      const int i = tabs_->indexOf(t->page);
      if (i >= 0 && i != at) tabs_->tabBar()->moveTab(i, at);
      ++at;
    }
    return;
  }
  if (op == "zoom") {
    if (!terms_.contains(id)) { noTerm(); return; }
    Tab* t = tabOf(terms_[id].tab);
    if (t && (!m.contains("on") || m.value("on").toBool() != (t->zoomed == id))) toggleZoom(id);
    return;
  }
  if (op == "minimise") {
    if (!terms_.contains(id)) { noTerm(); return; }
    setMinimised(id, m.contains("on") ? m.value("on").toBool() : !terms_[id].minimised);
    return;
  }
  if (op == "tree") { localTree_ = m.value("nodes").toArray(); if (machines_.isEmpty()) setTree(localTree_); else rebuildTree(); if (m.contains("select")) selectNode(m.value("select").toString()); return; }
  if (op == "sidebar") { if (m.contains("select")) selectNode(m.value("select").toString()); else sidebarFocus(); return; }
  if (op == "menu") { setMenus(m.value("menus").toArray()); return; }
  if (op == "ask") { ask(m); return; }
  if (op == "answer") {
    // Tests answer a dialog without clicking through it.
    FormDialog* d = asks_.value(id);
    if (!d) { reply(from, {{"ev", "error"}, {"error", "no dialog " + id}}); return; }
    if (m.value("cancelled").toBool()) d->reject();
    else d->answer(m.value("values").toObject());
    return;
  }
  if (op == "notify") {
    const bool err = m.value("level").toString() == "error";
    statusBar()->showMessage(m.value("text").toString(), err ? 20000 : 7000);
    if (m.value("alert").toBool() && !isActiveWindow()) QApplication::alert(this);
    return;
  }
  if (op == "busy") { busyLabel_->setText(m.value("text").toString()); return; }
  if (op == "placeholder") { placeholder_->setText(m.value("text").toString(kPlaceholder)); return; }
  if (op == "settings") {
    settingsSchema_ = m.value("schema").toObject();
    settingsValues_ = m.value("values").toObject();
    if (m.value("open").toBool()) openSettings();
    return;
  }
  if (op == "grab") {
    // A PNG of the window as drawn (or of one open dialog), for tests and bug reports.
    const QString path = m.value("path").toString();
    QWidget* what = m.contains("dialog") ? static_cast<QWidget*>(asks_.value(m.value("dialog").toString())) : this;
    reply(from, {{"ev", "grabbed"}, {"path", path}, {"ok", what && what->grab().save(path)}});
    return;
  }
  if (op == "screen") {
    // What a terminal shows, as text: tests and bug reports read it. `from`/`to` are
    // lines counted from the top of the scrollback; default is the visible screen.
    if (!terms_.contains(id)) { noTerm(); return; }
    QTermWidget* w = terms_[id].widget;
    const int hist = w->historyLinesCount(), rows = w->screenLinesCount(), cols = w->screenColumnsCount();
    const int first = m.contains("from") ? m.value("from").toInt() : hist;
    const int to = m.contains("to") ? m.value("to").toInt() : hist + rows - 1;
    const QString text = screenRows(terms_[id], first, to).join('\n');
    int cy = -1, cx = -1;
    cursorOf(terms_[id], &cy, &cx);
    reply(from, {{"ev", "screen"}, {"id", id}, {"text", text}, {"rows", rows}, {"cols", cols}, {"history", hist}, {"cy", cy}, {"cx", cx}});
    return;
  }
  if (op == "alpha") {
    // Tests: how solid the window is where a terminal's background is, and on its header.
    if (!terms_.contains(id)) { noTerm(); return; }
    QImage img(size(), QImage::Format_ARGB32_Premultiplied);
    img.fill(Qt::transparent);
    render(&img, QPoint(), QRegion(), QWidget::DrawChildren);
    const Term& t = terms_[id];
    const QPoint inTerm = t.widget->mapTo(this, QPoint(t.widget->width() - 40, t.widget->height() - 6));
    const QPoint inHeader = t.header->mapTo(this, QPoint(t.header->width() / 2, t.header->height() / 2));
    const QPoint mid = t.widget->mapTo(this, QPoint(t.widget->width() / 2, t.widget->height() / 2));
    reply(from, {{"ev", "alpha"}, {"id", id}, {"terminal", qAlpha(img.pixel(inTerm))}, {"middle", qAlpha(img.pixel(mid))}, {"header", qAlpha(img.pixel(inHeader))},
                 {"sidebar", qAlpha(img.pixel(tree_->mapTo(this, QPoint(10, tree_->height() - 10))))}, {"frozen", !t.widget->updatesEnabled()}, {"centerFills", center_->autoFillBackground()}});
    return;
  }
  if (op == "stale") {
    // Tests: does the terminal draw what its emulation holds? Its picture before and
    // after it is told to fetch the emulation's again.
    if (!terms_.contains(id)) { noTerm(); return; }
    QWidget* display = terms_[id].widget->focusProxy();
    const QImage before = display ? display->grab().toImage() : QImage();
    const bool told = display && QMetaObject::invokeMethod(display, "updateImage", Qt::DirectConnection);
    const QImage after = display ? display->grab().toImage() : QImage();
    reply(from, {{"ev", "stale"}, {"id", id}, {"stale", before != after}, {"told", told}});
    return;
  }
  if (op == "resize") { // tests give the window a size
    if (!qEnvironmentVariableIsSet("MC_TERM_TEST")) { reply(from, {{"ev", "error"}, {"error", "resize needs MC_TERM_TEST"}}); return; }
    resize(m.value("w").toInt(width()), m.value("h").toInt(height()));
    return;
  }
  if (op == "key") {
    // Tests press keys the way the keyboard does: through the window system's shortcut
    // handling, with whatever has focus getting its say first (a terminal does).
    if (!qEnvironmentVariableIsSet("MC_TERM_TEST")) { reply(from, {{"ev", "error"}, {"error", "key needs MC_TERM_TEST"}}); return; }
    activateWindow();
    if (m.contains("hold")) { // held down that long, then let go (the reply comes after)
      const QKeyCombination kc = QKeySequence(m.value("keys").toString())[0];
      QWidget* target = QApplication::focusWidget() ? QApplication::focusWidget() : this;
      QTest::keyPress(target, kc.key(), kc.keyboardModifiers());
      const int ms = m.value("hold").toInt();
      QTimer::singleShot(ms, this, [this, target, kc, from, m] {
        reply(from, {{"ev", "held"}, {"keys", m.value("keys").toString()}, {"badges", int(badges_.size())}, {"menuBar", menuBar()->isVisible()}});
        QTest::keyRelease(target, kc.key(), kc.keyboardModifiers());
      });
      return;
    }
    QTest::keySequence(windowHandle(), QKeySequence(m.value("keys").toString()));
    reply(from, {{"ev", "keyed"}, {"keys", m.value("keys").toString()}, {"focus", QApplication::focusWidget() ? QString(QApplication::focusWidget()->metaObject()->className()) : QString()}});
    return;
  }
  if (op == "list") {
    QJsonArray terms, tabNames, nodes, asks, acts;
    for (int i = 0; i < tabs_->count(); ++i) {
      const Tab* t = tabOf(tabName(i));
      if (!t) continue;
      tabNames.append(t->name);
      for (const QString& tid : t->order) {
        const Term& x = terms_[tid];
        // a machine's driver sees its own terminals, by its own names
        const QString askTag = clientTag_.value(from);
        // (this machine's driver sees only this machine's; anyone else, everything)
        if (!askTag.isEmpty() ? tagOf(x.id) != askTag : (from == driverSock_ && machines_.contains(tagOf(x.id)))) continue;
        terms.append(QJsonObject{{"id", askTag.isEmpty() ? x.id : untagName(x.id, askTag)}, {"tab", askTag.isEmpty() ? x.tab : untagName(x.tab, askTag)}, {"title", x.title}, {"attention", x.attention}, {"node", x.node},
                                 {"minimised", x.minimised}, {"zoomed", t->zoomed == x.id}, {"active", activeId_ == x.id},
                                 {"onScreen", visible(*t).contains(x.id)}, {"scheme", x.ownScheme}, {"native", x.native}, {"live", x.live}, {"held", x.off}, {"cols", x.widget->screenColumnsCount()}, {"rows", x.widget->screenLinesCount()},
                                 {"history", x.widget->historyLinesCount()}, {"pending", x.feed ? double(x.feed->pending()) : 0.0}});
      }
    }
    for (auto it = nodeItems_.begin(); it != nodeItems_.end(); ++it) nodes.append(QJsonObject{{"id", it.key()}, {"label", it.value()->text(0)}, {"badge", it.value()->text(1)}});
    for (auto it = asks_.begin(); it != asks_.end(); ++it) asks.append(it.key());
    for (QAction* a : actions_) acts.append(a->data().toString());
    const Tab* cur = currentTab();
    reply(from, {{"ev", "list"}, {"terminals", terms}, {"tabs", tabNames}, {"current", cur ? cur->name : QString()}, {"nodes", nodes},
                 {"asks", asks}, {"actions", acts}, {"selected", currentNode()}, {"sidebar", dock_->isVisible()}, {"driver", driver_ != nullptr},
                 {"shown", isVisible() && !(windowState() & Qt::WindowMinimized)}, {"fullScreen", isFullScreen()}, {"keyBar", keyBar_ && keyBar_->isVisible()}, {"menuBar", menuBar()->isVisible()}, {"badges", int(badges_.size())}, {"keyBarText", keyBar_ ? keyBar_->text() : QString()}, {"activeWindow", isActiveWindow()}});
    return;
  }
  reply(from, {{"ev", "error"}, {"error", "unknown op " + op}});
}

// ---- terminals -----------------------------------------------------------------------

// The terminals' font, and whether bold may be used: a bold face wider than the regular one
// (Noto Sans Mono's, by a pixel) pushes each bold run over the text after it.
QFont Host::termFont(bool* boldFits) const {
  QFont f = font_.isEmpty() ? QFontDatabase::systemFont(QFontDatabase::FixedFont) : QFont(font_);
  f.setPointSize(fontSize_);
  f.setStyleHint(QFont::Monospace);
  f.setFixedPitch(true);
  f.setKerning(false);
  // Without a desktop theme to ask (a static build has none) the "fixed" font can come
  // back proportional: then the first monospace family fontconfig knows.
  if (!QFontInfo(f).fixedPitch()) {
    for (const char* fam : {"monospace", "Hack", "JetBrains Mono", "DejaVu Sans Mono", "Noto Sans Mono", "Liberation Mono", "Source Code Pro", "Ubuntu Mono"}) {
      QFont g(f);
      g.setFamily(QString::fromLatin1(fam));
      if (QFontInfo(g).fixedPitch()) { f = g; break; }
    }
  }
  if (boldFits) {
    QFont probe(f);
    probe.setHintingPreference(QFont::PreferFullHinting); // what the terminal draws with
    probe.setStyleName(QString());
    QFont bold(probe);
    bold.setBold(true);
    *boldFits = qFuzzyCompare(QFontMetricsF(probe).horizontalAdvance(QLatin1Char('M')), QFontMetricsF(bold).horizontalAdvance(QLatin1Char('M')));
  }
  return f;
}

void Host::applyFont() {
  bool bold = true;
  const QFont f = termFont(&bold);
  for (auto& t : terms_) { t.widget->setBoldIntense(bold); setTextStep(t, t.textStep, false); }
}

Tab* Host::tabOf(const QString& name) {
  auto it = tabsByName_.find(name);
  return it == tabsByName_.end() ? nullptr : &it.value();
}

QString Host::tabName(int index) const {
  QWidget* page = tabs_->widget(index);
  for (auto it = tabsByName_.constBegin(); it != tabsByName_.constEnd(); ++it) if (it->page == page) return it->name;
  return QString();
}

Tab* Host::currentTab() { return tabOf(tabName(tabs_->currentIndex())); }

Tab& Host::tabFor(const QString& name) {
  if (!tabsByName_.contains(name)) {
    Tab t;
    t.name = name;
    t.page = new QWidget(tabs_);
    auto* lay = new QVBoxLayout(t.page);
    lay->setContentsMargins(0, 0, 0, 0);
    lay->setSpacing(0);
    t.rows = new QSplitter(Qt::Vertical, t.page);
    t.rows->setChildrenCollapsible(false);
    t.rows->setHandleWidth(1);
    lay->addWidget(t.rows, 1);
    t.strip = new QWidget(t.page);
    t.strip->setObjectName("strip");
    t.strip->setAttribute(Qt::WA_StyledBackground, true);
    t.stripLay = new QHBoxLayout(t.strip);
    t.stripLay->setContentsMargins(0, 0, 4, 0);
    t.stripLay->setSpacing(2);
    t.strip->hide();
    lay->addWidget(t.strip);
    tabs_->addTab(t.page, name);
    tabsByName_.insert(name, t);
    updateCenter();
  }
  return tabsByName_[name];
}

void Host::updateCenter() { center_->setCurrentWidget(tabs_->count() ? static_cast<QWidget*>(tabs_) : placeholder_); }

void Host::open(const QJsonObject& m) {
  const QString id = m.value("id").toString();
  if (qEnvironmentVariableIsSet("MC_TERM_DEBUG")) fprintf(stderr, "open %s %s\n", qPrintable(id), QJsonDocument(m.value("tmux").toObject()).toJson(QJsonDocument::Compact).constData());
  if (id.isEmpty()) return;
  if (terms_.contains(id)) { if (m.value("focus").toBool()) focusTerm(id); return; }
  // Two kinds. "tmux": a pane of a tmux session, shown natively (tmuxctl.h). "argv": a
  // program run here, on a pty of its own.
  const QJsonObject tm = m.value("tmux").toObject();
  const bool native = !tm.isEmpty();
  Term t;
  t.id = id;
  t.tab = m.value("tab").toString(id.section('/', 0, 0));
  t.title = m.value("title").toString(id.section('/', -1));
  t.color = m.value("color").toString("#888888");
  t.attention = m.value("attention").toString();
  t.node = m.value("node").toString();
  t.ownScheme = m.value("scheme").toString();
  t.native = native;
  t.session = tm.value("session").toString();
  t.pane = tm.value("pane").toString();
  t.window = tm.value("window").toString();

  t.box = new QFrame;
  t.box->setFrameShape(QFrame::NoFrame);
  auto* lay = new QVBoxLayout(t.box);
  lay->setContentsMargins(0, 0, 0, 0);
  lay->setSpacing(0);
  t.header = new Header(t.box);
  t.header->setFixedHeight(23);
  t.header->setContentsMargins(8, 0, 8 + 3 * 20, 0); // room on the right for the window buttons
  t.header->setTextFormat(Qt::RichText);
  lay->addWidget(t.header);
  {
    // A pane is a little window: _ [] X in its top right (minimise, maximise, close).
    // Close asks the driver (it may be a peer, whose removal is confirmed).
    auto* bl = new QHBoxLayout;
    bl->setContentsMargins(0, 2, 4, 2);
    bl->addStretch(1);
    bl->setSpacing(2);
    // drawn here, light on the dark headers: the style's own title bar icons are dark
    const auto glyph = [](QStyle::StandardPixmap which) {
      QPixmap pm(26, 26);
      pm.fill(Qt::transparent);
      QPainter p(&pm);
      p.setRenderHint(QPainter::Antialiasing);
      p.setPen(QPen(QColor("#d4d8e1"), 2.2, Qt::SolidLine, Qt::RoundCap));
      if (which == QStyle::SP_TitleBarMinButton) p.drawLine(QPointF(7, 18), QPointF(19, 18));
      else if (which == QStyle::SP_TitleBarMaxButton) p.drawRect(QRectF(7, 7, 12, 12));
      else { p.drawLine(QPointF(7.5, 7.5), QPointF(18.5, 18.5)); p.drawLine(QPointF(18.5, 7.5), QPointF(7.5, 18.5)); }
      return QIcon(pm);
    };
    const auto button = [&](QStyle::StandardPixmap icon, const QString& tip, auto fn) {
      auto* b = new QToolButton(t.header);
      b->setIcon(glyph(icon));
      b->setIconSize(QSize(13, 13));
      b->setStyleSheet(icon == QStyle::SP_TitleBarCloseButton
        ? "QToolButton { border: 0; border-radius: 3px; background: rgba(0,0,0,60); } QToolButton:hover { background: #e5484d; }"
        : "QToolButton { border: 0; border-radius: 3px; background: rgba(0,0,0,60); } QToolButton:hover { background: rgba(255,255,255,40); }");
      b->setFixedSize(18, 18);
      b->setAutoRaise(true);
      b->setFocusPolicy(Qt::NoFocus);
      b->setToolTip(tip);
      connect(b, &QToolButton::clicked, this, fn);
      bl->addWidget(b);
    };
    button(QStyle::SP_TitleBarMinButton, "Minimise (Ctrl+Shift+M)", [this, id] { setMinimised(id, true); });
    button(QStyle::SP_TitleBarMaxButton, "Maximise / restore (Ctrl+Shift+Z, or double-click)", [this, id] { toggleZoom(id); });
    button(QStyle::SP_TitleBarCloseButton, "Close (Ctrl+W)", [this, id] {
      emitEvent({{"ev", "action"}, {"action", "pane.close"}, {"id", id}, {"node", terms_.value(id).node}, {"tab", terms_.value(id).tab}, {"focus", "term"}});
    });
    t.header->setLayout(bl);
  }

  auto* w = new QTermWidget(0, t.box);
  t.widget = w;
  w->setProperty("mcId", id);
  if (!native) {
    const QJsonArray argv = m.value("argv").toArray();
    if (!argv.isEmpty()) {
      w->setShellProgram(argv.first().toString());
      QStringList args;
      for (int i = 1; i < argv.size(); ++i) args << argv[i].toString();
      w->setArgs(args);
    }
    if (m.contains("cwd")) w->setWorkingDirectory(m.value("cwd").toString());
    QStringList env;
    const QJsonObject envObj = m.value("env").toObject();
    for (auto it = envObj.begin(); it != envObj.end(); ++it) env << it.key() + "=" + it.value().toString();
    // Scrollback files go where TMPDIR points; the program keeps the TMPDIR we were given.
    env << "MC_TERM_ID=" + id << "MC_TERM_SOCKET=" + socketPath_ << "TMPDIR=" + (hadTmpDir_ ? origTmpDir_ : QString("/tmp"));
    w->setEnvironment(env);
  }
  bool bold = true;
  const QFont f = termFont(&bold);
  w->setBoldIntense(bold);
  w->setTerminalFont(f);
  // A native pane's scrollback is this widget's own: unlimited by default, in files, not
  // in memory. A program that keeps its own (tmux drawing a pane) gets none here.
  const bool scroll = native || m.value("scroll").toBool();
  w->setScrollBarPosition(scroll ? QTermWidget::ScrollBarRight : QTermWidget::NoScrollBar);
  w->setHistorySize(scroll ? scrollback_ : 0);
  w->setMargin(8);
  w->setBlinkingCursor(!qEnvironmentVariableIsSet("MC_TERM_TEST")); // tests compare pictures
  w->setTerminalSizeHint(false);       // no "Size: 80 x 24" box over the text on every resize
  w->setConfirmMultilinePaste(false);  // programs that care ask for bracketed paste
  w->setTrimPastedTrailingNewlines(false);
  lay->addWidget(w, 1);

  // The part of the widget that draws and takes the keys: see eventFilter.
  if (QWidget* display = w->focusProxy()) {
    display->setProperty("mcDisplay", id);
    display->installEventFilter(this);
  }
  t.redrawTimer = new QTimer(w);
  t.redrawTimer->setSingleShot(true);
  t.redrawTimer->setInterval(30);
  connect(t.redrawTimer, &QTimer::timeout, this, [this, id] { redraw(id); });

  auto* hook = new TermHook(w);
  hook->finished = [this, id] {
    emitEvent({{"ev", "exited"}, {"id", id}});
    // Tear down from the event loop, not from inside the widget's own signal.
    QMetaObject::invokeMethod(this, [this, id] { closeTerm(id, false); }, Qt::QueuedConnection);
  };
  hook->focused = [this, id] { setActive(id); };
  hook->bell = [this, id] { emitEvent({{"ev", "bell"}, {"id", id}}); };
  hook->title = [this, id, w] { emitEvent({{"ev", "title"}, {"id", id}, {"title", w->title()}}); };
  hook->selected = [this, w](bool yes) { if (yes && copyOnSelect_) w->copyClipboard(); };
  bool ok = connect(w, SIGNAL(finished()), hook, SLOT(onFinished()))
    && connect(w, SIGNAL(termGetFocus()), hook, SLOT(onFocused()))
    && connect(w, SIGNAL(bell(QString)), hook, SLOT(onBell(QString)))
    && connect(w, SIGNAL(titleChanged()), hook, SLOT(onTitle()))
    && connect(w, SIGNAL(urlActivated(QUrl,bool)), hook, SLOT(onUrl(QUrl,bool)))
    && connect(w, SIGNAL(copyAvailable(bool)), hook, SLOT(onCopyAvailable(bool)));
  if (native) {
    hook->send = [this, id](const QByteArray& bytes) {
      auto it = terms_.find(id);
      if (it == terms_.end()) return;
      if (TmuxControl* c = controls_.value(it->session)) c->sendKeys(it->pane, tmuxKeys(bytes));
    };
    ok = ok && connect(w, SIGNAL(sendData(const char*,int)), hook, SLOT(onSend(const char*,int)));
    t.resizeTimer = new QTimer(w);
    t.resizeTimer->setSingleShot(true);
    t.resizeTimer->setInterval(40);
    connect(t.resizeTimer, &QTimer::timeout, this, [this, id] {
      auto it = terms_.find(id);
      if (it == terms_.end()) return;
      const bool resized = it->resizePending;
      it->resizePending = false;
      syncSize(id, resized);
    });
    t.reflowTimer = new QTimer(w);
    t.reflowTimer->setSingleShot(true);
    connect(t.reflowTimer, &QTimer::timeout, this, [this, id] { reflowCheck(id); });
    t.thawTimer = new QTimer(w);
    t.thawTimer->setSingleShot(true);
    connect(t.thawTimer, &QTimer::timeout, this, [this, id] { thaw(id); });
    w->installEventFilter(this);
    w->setContextMenuPolicy(Qt::CustomContextMenu);
    connect(w, &QWidget::customContextMenuRequested, this, [this, id, w](const QPoint& p) { if (terms_.contains(id)) showNodeMenu(terms_[id].node, w->mapToGlobal(p), id); });
  }
  if (!ok) qFatal("mc-term: cannot connect to QTermWidget's signals");
  connect(t.header, &Header::pressed, this, [this, id] { focusTerm(id); });
  connect(t.header, &Header::doubleClicked, this, [this, id] { toggleZoom(id); });
  connect(t.header, &Header::menuRequested, this, [this, id](const QPoint& p) { if (terms_.contains(id)) showNodeMenu(terms_[id].node, p, id); });

  terms_.insert(id, t);
  Tab& tab = tabFor(t.tab);
  tab.order << id;
  applyTheme(terms_[id]);
  paintHeader(terms_[id]);
  retile(tab);
  paintTab(tab);
  if (native) startNative(id);
  else w->startShellProgram();
  emitEvent({{"ev", "opened"}, {"id", id}, {"tab", t.tab}});
  if (m.value("focus").toBool()) focusTerm(id);
}

// ---- tmux panes shown natively -------------------------------------------------------

namespace {
// Bytes waiting for one terminal before tmux's output is left in the pipe (tests lower it
// to get there). Small on purpose: the other panes of the session wait behind it.
const qint64 kHighWater = qEnvironmentVariableIsSet("MC_TERM_HIGH_WATER") ? qEnvironmentVariableIntValue("MC_TERM_HIGH_WATER") : (512 * 1024);

// Pane ids ("%3") are place markers to QString::arg, so these commands are put together by
// hand; by pane, not window: the pane may have moved.
QString resizeCommand(const QString& pane, int cols, int rows) {
  return "resize-window -t " + pane + " -x " + QString::number(cols) + " -y " + QString::number(rows);
}

QByteArray csi(const QByteArray& body) { return QByteArray("\x1b[") + body; }
QByteArray at(int row, int col) { return csi(QByteArray::number(row) + ';' + QByteArray::number(col) + 'H'); }

// The widget's modes back to a terminal's defaults; what it shows is not touched.
const char kPlainModes[] = "\x1b[?1049l\x1b[r\x1b[?6l\x1b[?7h\x1b[4l\x1b[0m\x1b(B\x0f\x1b[?25h\x1b[?1l\x1b>\x1b[?2004l"
                           "\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1005l\x1b[?1006l\x1b[?1004l\x1b[0 q";

// A row captured with its escapes as the text it draws, line-drawing cells (SO … SI) as the
// box characters they are.
QString drawnText(const QByteArray& row) {
  static const char* const acs[] = {"◆", "▒", "␉", "␌", "␍", "␊", "°", "±", "␤", "␋", "┘", "┐", "┌", "└", "┼", "⎺", "⎻", "─", "⎼", "⎽", "├", "┤", "┴", "┬", "│", "≤", "≥", "π", "≠", "£", "·"};
  QByteArray out;
  bool graphics = false;
  for (int i = 0; i < row.size(); ++i) {
    const unsigned char c = static_cast<unsigned char>(row[i]);
    if (c == 0x0e) graphics = true;
    else if (c == 0x0f) graphics = false;
    else if (c == 0x1b && i + 1 < row.size() && row[i + 1] == '[') {
      for (i += 2; i < row.size() && !(row[i] >= 0x40 && row[i] <= 0x7e); ++i) {}
    } else if (c == 0x1b && i + 1 < row.size() && row[i + 1] == ']') {
      for (i += 2; i < row.size() && row[i] != 0x07 && !(row[i] == 0x1b && i + 1 < row.size() && row[i + 1] == '\\'); ++i) {}
      if (i < row.size() && row[i] == 0x1b) ++i;
    } else if (graphics && c >= 0x60 && c <= 0x7e) out += acs[c - 0x60];
    else out += char(c);
  }
  // tmux keeps a tab as a tab; on a screen it is the blanks up to the next stop
  const QString text = QString::fromUtf8(out);
  if (!text.contains('\t')) return text;
  QString flat;
  int col = 0;
  for (const uint u : text.toUcs4()) {
    if (u == '\t') { const int n = 8 - col % 8; flat += QString(n, ' '); col += n; continue; }
    flat += QString::fromUcs4(reinterpret_cast<const char32_t*>(&u), 1);
    col += qMax(0, wcwidth(wchar_t(u)));
  }
  return flat;
}

// What tmux tells about a pane, tab separated; F names the fields.
const char kFacts[] = "#{pane_width}\t#{pane_height}\t#{alternate_on}\t#{cursor_x}\t#{cursor_y}\t#{cursor_flag}\t#{keypad_cursor_flag}\t#{keypad_flag}\t#{bracket_paste_flag}"
                      "\t#{mouse_standard_flag}\t#{mouse_button_flag}\t#{mouse_all_flag}\t#{mouse_sgr_flag}\t#{mouse_utf8_flag}\t#{wrap_flag}\t#{insert_flag}\t#{origin_flag}"
                      "\t#{scroll_region_upper}\t#{scroll_region_lower}\t#{history_size}\t#{history_limit}\t#{@mc_focus}\t#{cursor_shape}\t#{cursor_blinking}\t#{alternate_saved_x}\t#{alternate_saved_y}";
enum F { FWidth, FHeight, FAlt, FCx, FCy, FCursor, FAppCursor, FKeypad, FPaste, FMouseStd, FMouseBtn, FMouseAll, FMouseSgr, FMouseUtf8, FWrap, FInsert, FOrigin,
         FTop, FBottom, FHistory, FLimit, FFocus, FShape, FBlink, FSavedX, FSavedY };
}

// What children get: our environment, minus the TMPDIR we moved for scrollback (tmux looks
// for its socket under TMPDIR when TMUX_TMPDIR is unset).
QProcessEnvironment Host::childEnv() const {
  QProcessEnvironment env = QProcessEnvironment::systemEnvironment();
  if (hadTmpDir_) env.insert("TMPDIR", origTmpDir_);
  else env.remove("TMPDIR");
  env.insert("MC_TERM_SOCKET", socketPath_);
  return env;
}

TmuxControl* Host::controlFor(const QString& session) {
  if (TmuxControl* have = controls_.value(session)) return have;
  QString realSession;
  const QStringList tmuxCmd = tmuxFor(session, &realSession);
  auto* c = new TmuxControl(realSession, childEnv(), tmuxCmd, this);
  controls_.insert(session, c);
  connect(c, &TmuxControl::output, this, [this, session](const QString& pane, const QByteArray& data) {
    auto it = terms_.find(paneIds_.value(session + ' ' + pane));
    if (it == terms_.end() || !it->live) return; // not shown, or its state is still being fetched
    it->lastOutput = clock_.elapsed();
    it->feed->write(it->dialect->feed(data));
    // The display is behind: stop reading tmux until it has caught up (see setThrottled).
    if (it->feed->pending() > kHighWater) {
      it->off = true;
      if (TmuxControl* c2 = controls_.value(session)) c2->setThrottled(true);
    }
  });
  connect(c, &TmuxControl::paused, this, [this, session](const QString& pane) {
    // tmux let the program run on without us (we fell behind): read the pane again, keeping
    // the scrollback gathered so far
    auto it = terms_.find(paneIds_.value(session + ' ' + pane));
    if (it == terms_.end() || !it->live) return;
    const QString id = it->id;
    const bool keep = it->widget->historyLinesCount() > seedLines_;
    emitEvent({{"ev", "fell-behind"}, {"id", id}});
    seed(id, keep);
  });
  connect(c, &TmuxControl::exited, this, [this, session](const QString& reason) { controlGone(session, reason); });
  return c;
}

// The control client ended: with its session gone so are the panes; otherwise a new client
// takes over and the terminals keep their scrollback.
void Host::controlGone(const QString& session, const QString& reason) {
  if (qEnvironmentVariableIsSet("MC_TERM_DEBUG")) fprintf(stderr, "control for %s gone: %s\n", qPrintable(session), qPrintable(reason));
  if (TmuxControl* c = controls_.take(session)) c->deleteLater();
  QStringList ids;
  for (Term& t : terms_) if (t.native && t.session == session) { ids << t.id; t.live = false; t.off = false; }
  if (ids.isEmpty()) return;
  const auto drop = [this, ids, reason] {
    for (const QString& id : ids) {
      if (!terms_.contains(id)) continue;
      emitEvent({{"ev", "exited"}, {"id", id}, {"reason", reason}});
      QMetaObject::invokeMethod(this, [this, id] { closeTerm(id, false); }, Qt::QueuedConnection);
    }
  };
  const qint64 now = QDateTime::currentMSecsSinceEpoch();
  QList<qint64>& lost = controlLost_[session];
  while (!lost.isEmpty() && now - lost.first() > 60000) lost.removeFirst();
  lost << now;
  if (quitting_ || lost.size() > 3) { drop(); return; } // three losses in a minute is not a blip
  auto* probe = new QProcess(this);
  probe->setProcessEnvironment(childEnv());
  connect(probe, &QProcess::errorOccurred, this, [probe, drop](QProcess::ProcessError e) { if (e == QProcess::FailedToStart) { probe->deleteLater(); drop(); } });
  connect(probe, &QProcess::finished, this, [this, probe, session, ids, drop, reason](int code, QProcess::ExitStatus how) {
    probe->deleteLater();
    if (how != QProcess::NormalExit || code != 0) { drop(); return; }
    QStringList left;
    for (const QString& id : ids) if (terms_.contains(id)) left << id;
    if (left.isEmpty() || controls_.contains(session)) return;
    TmuxControl* c = controlFor(session);
    for (const QString& id : left) {
      Term& t = terms_[id];
      c->show(t.pane, true);
      t.dialect->reset();
      if (t.seeded) seed(id, true);
    }
    emitEvent({{"ev", "reattached"}, {"session", session}, {"reason", reason}});
  });
  QString realSession;
  const QStringList probeCmd = tmuxFor(session, &realSession);
  probe->start(probeCmd.value(0, "tmux"), probeCmd.mid(1) + QStringList{"has-session", "-t", "=" + realSession});
}

void Host::startNative(const QString& id) {
  Term& t = terms_[id];
  t.widget->startTerminalTeletype();
  const int fd = t.widget->getPtySlaveFd();
  // Raw: the bytes are a program's output as tmux read them, already through a tty once.
  struct termios tio;
  if (tcgetattr(fd, &tio) == 0) { cfmakeraw(&tio); tcsetattr(fd, TCSANOW, &tio); }
  fcntl(fd, F_SETFL, fcntl(fd, F_GETFL) | O_NONBLOCK);
  t.feed = new Feed(fd, t.widget);
  connect(t.feed, &Feed::drained, this, [this, id] {
    resume(id);
    auto it = terms_.find(id);
    if (it != terms_.end() && !it->widget->updatesEnabled()) it->thawTimer->start(40); // the widget reads its pty a moment later
  });
  t.dialect = QSharedPointer<Dialect>::create();
  const QString session = t.session, pane = t.pane;
  t.dialect->clipboard = [this, id](const QByteArray& text) {
    if (!clipboardFromPrograms_ || text.size() > (4 << 20) || !terms_.contains(id)) return;
    const QString str = QString::fromUtf8(text);
    QGuiApplication::clipboard()->setText(str);
    statusBar()->showMessage(QString("%1 copied %2 characters to the clipboard").arg(terms_[id].title).arg(str.size()), 4000);
  };
  t.dialect->notify = [this, id](const QByteArray& title, const QByteArray& body) {
    emitEvent({{"ev", "note"}, {"id", id}, {"title", QString::fromUtf8(title)}, {"body", QString::fromUtf8(body)}});
  };
  // Whether a program asked for focus reports is not among what tmux tells about a pane:
  // it is noted on the pane itself, for the next window that shows it.
  t.dialect->mode = [this, session, pane](int mode, bool on) {
    if (mode != 1004) return;
    if (TmuxControl* c = controls_.value(session)) c->command("set-option -p -t " + pane + " @mc_focus " + (on ? "1" : "0"));
  };
  paneIds_.insert(t.session + ' ' + t.pane, id);
  controlFor(t.session)->show(t.pane, true);
  // The pane's state is fetched once the widget has settled at its size (the grid lays it
  // out after this returns): scrollback printed at a passing width would stay wrapped at it.
  t.resizeTimer->start(200);
}

// The pane's state in one tmux batch (paused, captured, continued), so the output after it is
// exactly what followed the capture. `keep`: only the screen is redone.
void Host::seed(const QString& id, bool keep) {
  auto it = terms_.find(id);
  if (it == terms_.end() || !it->native) return;
  TmuxControl* c = controls_.value(it->session);
  if (!c) return;
  it->seeded = true;
  it->live = false;
  it->seededGen = it->resizeGen;
  it->skewKnown = false;
  it->cols = it->widget->screenColumnsCount();
  it->rows = it->widget->screenLinesCount();
  const QString pane = it->pane;
  c->batch({
    resizeCommand(pane, it->cols, it->rows),
    QString("refresh-client -A '%1:pause'").arg(pane),
    QString("display-message -p -t %1 %2").arg(pane, TmuxControl::quote(kFacts)),
    // whole lines (the widget wraps), never "all": tmux builds the answer in memory, in the
    // one server every session lives in
    keep ? QString("display-message -p ''") : QString("capture-pane -p -e -J -S -%2 -E -1 -t %1").arg(pane, QString::number(seedLines_)),
    QString("capture-pane -p -e -N -S 0 -E - -t %1").arg(pane),       // the screen as it is
    QString("capture-pane -p -e -N -q -a -S 0 -E - -t %1").arg(pane), // the screen saved under an alternate one
    QString("refresh-client -A '%1:continue'").arg(pane),
  }, [this, id, keep](const QList<TmuxControl::Block>& r) {
    if (!terms_.contains(id)) return;
    if (qEnvironmentVariableIsSet("MC_TERM_DEBUG"))
      for (int i = 0; i < r.size(); ++i) if (!r[i].ok) fprintf(stderr, "seed %s: command %d failed: %s\n", qPrintable(id), i, r[i].lines.value(0).constData());
    if (r.size() < 7 || !r[2].ok) { // the pane is gone
      emitEvent({{"ev", "exited"}, {"id", id}});
      QMetaObject::invokeMethod(this, [this, id] { closeTerm(id, false); }, Qt::QueuedConnection);
      return;
    }
    applySeed(id, r[2].lines.value(0), keep ? QList<QByteArray>() : r[3].lines, r[4].lines, r[5].lines, keep);
  });
}

void Host::applySeed(const QString& id, const QByteArray& factsLine, const QList<QByteArray>& history, const QList<QByteArray>& screen, const QList<QByteArray>& saved, bool keep) {
  Term& t = terms_[id];
  const QList<QByteArray> f = factsLine.split('\t');
  const auto num = [&](int i) { return f.value(i).toInt(); };
  const int paneRows = qMax(1, num(FHeight));
  const bool alt = num(FAlt) == 1;
  // tmux captures its first screen line when asked for the history of a pane that has none.
  const int lines = num(FHistory) == 0 ? 0 : int(history.size());
  if (qEnvironmentVariableIsSet("MC_TERM_DEBUG")) {
    QByteArray l0 = factsLine;
    fprintf(stderr, "seed %s%s: facts [%s], history %d, screen %d, saved %d\n", qPrintable(id), keep ? " (screen only)" : "", l0.replace('\t', '|').constData(), lines, int(screen.size()), int(saved.size()));
  }
  const int rows = qMax(1, t.widget->screenLinesCount());
  Dialect plain; // captured lines carry colours in tmux's own spelling
  // The rows of a captured screen, each at its place over whatever was there. Never wraps,
  // never scrolls.
  const auto paint = [&](const QList<QByteArray>& src) {
    QByteArray o = csi("?7l");
    const int n = qMin<int>(qMin(paneRows, rows), src.size());
    for (int i = 0; i < n; ++i) o += at(i + 1, 1) + "\x0f" + csi("0m") + csi("2K") + plain.feed(src[i]);
    if (n < rows) o += at(n + 1, 1) + csi("0m") + csi("J");
    return o + csi("0m");
  };
  // Captured rows mark line-drawing cells with SO/SI, which takes G1 set to that charset.
  QByteArray out = QByteArray(kPlainModes) + "\x1b)0";
  if (!keep) {
    // scrollback anew: dropped, the screen blanked with H J (2J would file it), then every line
    // through a two-row scroll region so each becomes one scrollback row
    out += csi("3J") + csi("H") + csi("J");
    if (lines > 0 && rows >= 2) {
      out += csi("1;2r");
      for (int i = 0; i < lines; ++i) out += csi("0m") + plain.feed(history[i]) + "\x0f" + csi("0m") + "\r\n";
      out += "\n" + csi("r");
    }
  }
  out += paint(alt ? saved : screen);
  // Entering the alternate screen saves the cursor of the one under it: put it where the
  // program left it there, for when it comes back.
  if (alt) out += at(num(FSavedY) + 1, num(FSavedX) + 1) + csi("?1049h") + paint(screen);
  out += "\x0f\x1b)B"; // G1 as a program finds it in tmux
  // The modes the program had set, then the cursor.
  const int top = num(FTop), bottom = num(FBottom);
  const bool region = top > 0 || (bottom > 0 && bottom < paneRows - 1);
  if (region) out += csi(QByteArray::number(top + 1) + ";" + QByteArray::number(bottom + 1) + "r");
  if (num(FWrap)) out += csi("?7h");
  if (num(FInsert)) out += csi("4h");
  if (num(FAppCursor)) out += csi("?1h");
  if (num(FKeypad)) out += "\x1b=";
  if (num(FPaste)) out += csi("?2004h");
  if (num(FMouseStd)) out += csi("?1000h");
  if (num(FMouseBtn)) out += csi("?1002h");
  if (num(FMouseAll)) out += csi("?1003h");
  if (num(FMouseUtf8)) out += csi("?1005h");
  if (num(FMouseSgr)) out += csi("?1006h");
  if (num(FFocus)) out += csi("?1004h");
  const QByteArray shape = f.value(FShape);
  const int blink = num(FBlink) ? 1 : 2;
  if (shape == "block") out += csi(QByteArray::number(blink) + " q");
  else if (shape == "underline") out += csi(QByteArray::number(blink + 2) + " q");
  else if (shape == "bar") out += csi(QByteArray::number(blink + 4) + " q");
  // With origin mode the cursor is addressed from the top of the scroll region.
  if (num(FOrigin)) out += csi("?6h") + at(num(FCy) - (region ? top : 0) + 1, num(FCx) + 1);
  else out += at(num(FCy) + 1, num(FCx) + 1);
  if (!num(FCursor)) out += csi("?25l");
  // not drawn until it is all in (what it shows now is painted first: a widget that never
  // painted would be a hole in a see-through window)
  if (t.widget->isVisible() && t.widget->updatesEnabled()) t.widget->repaint();
  t.widget->setUpdatesEnabled(false);
  t.thawTimer->start(3000); // however it goes, not for long
  t.dialect->reset();
  t.feed->write(out);
  t.live = true;
  t.off = false;
  // The grid may have moved while tmux answered; and once this has settled, is the widget
  // in step with tmux?
  if (t.resizeTimer) t.resizeTimer->start();
  t.resizedAt = clock_.elapsed();
  t.reflowTimer->start(400);
  emitEvent({{"ev", "seeded"}, {"id", id}, {"history", lines}, {"gap", keep}});
}

void Host::thaw(const QString& id) {
  auto it = terms_.find(id);
  if (it == terms_.end()) return;
  it->thawTimer->stop();
  if (!it->widget->updatesEnabled()) it->widget->setUpdatesEnabled(true);
  redraw(id);
}

// The widget repaints only when the program writes; a new layout loses its picture and an idle
// program writes nothing, so after every show and resize it is told to repaint.
void Host::redraw(const QString& id) {
  auto it = terms_.find(id);
  if (it == terms_.end()) return;
  QWidget* display = it->widget->focusProxy();
  if (!display || qEnvironmentVariableIsSet("MC_TERM_NO_REDRAW")) return; // the switch is for the test of the test
  QMetaObject::invokeMethod(display, "updateImage", Qt::DirectConnection);
  display->update();
}

// The widget's size in cells is the pane's size: tmux resizes the window, the program
// gets its SIGWINCH.
void Host::syncSize(const QString& id, bool resized) {
  auto it = terms_.find(id);
  if (it == terms_.end() || !it->native) return;
  if (!it->seeded) {
    if (it->widget->isVisible() && it->widget->width() > 60 && it->widget->screenLinesCount() >= 2) seed(id, false);
    else it->resizeTimer->start(200); // minimised or not laid out yet: look again
    return;
  }
  const int cols = it->widget->screenColumnsCount(), rows = it->widget->screenLinesCount();
  if (cols < 2 || rows < 1) return;
  const bool same = cols == it->cols && rows == it->rows;
  if (same && !resized) return;
  if (!same) {
    it->cols = cols;
    it->rows = rows;
    if (TmuxControl* c = controls_.value(it->session)) c->command(resizeCommand(it->pane, cols, rows));
  }
  // also at an unchanged size: passing through a new layout may have moved its lines
  // while tmux moved nothing
  ++it->resizeGen;
  it->resizedAt = clock_.elapsed();
  it->reflowTimer->start(300);
}

// The widget's rows as text, trailing blanks off; `first` and `last` count from the top of
// its scrollback. Read through its selection (the only way in), which is cleared after.
QStringList Host::screenRows(const Term& t, int first, int last) const {
  QTermWidget* w = t.widget;
  const int cols = w->screenColumnsCount();
  QStringList out;
  for (int r = first; r <= last; ++r) {
    w->setSelectionStart(r, 0);
    w->setSelectionEnd(r, cols - 1);
    QString s = w->selectedText(true);
    while (s.endsWith(' ') || s.endsWith('\n')) s.chop(1);
    out << s;
  }
  w->setSelectionStart(0, -1); // no selection
  return out;
}

// Where the widget's cursor is, on its screen. With nothing selected the library reports
// the cursor as the "selection start" (and adds the scrollback length to both numbers).
bool Host::cursorOf(const Term& t, int* row, int* col) const {
  if (!t.widget->selectedText(true).isEmpty()) return false;
  int r = 0, c = 0;
  t.widget->getSelectionStart(r, c);
  const int hist = t.widget->historyLinesCount();
  *row = r - hist;
  *col = c - hist;
  return true;
}

// tmux rewraps on resize, this widget only clips: once the pane is quiet, a widget that no
// longer shows what tmux holds reads the pane again.
void Host::reflowCheck(const QString& id) {
  auto it = terms_.find(id);
  if (qEnvironmentVariableIsSet("MC_TERM_DEBUG") && it != terms_.end()) fprintf(stderr, "reflowCheck %s: live %d, last output %lld ms ago, pending %lld, resized %lld ms ago\n", qPrintable(id), it->live, clock_.elapsed() - it->lastOutput, it->feed ? it->feed->pending() : -1, clock_.elapsed() - it->resizedAt);
  if (it == terms_.end() || !it->native || !it->live) return;
  TmuxControl* c = controls_.value(it->session);
  if (!c) return;
  const qint64 now = clock_.elapsed();
  const bool quiet = now - it->lastOutput >= 250 && it->feed->pending() == 0;
  if (!quiet && now - it->resizedAt < 2500) { it->reflowTimer->start(150); if (qEnvironmentVariableIsSet("MC_TERM_DEBUG")) fprintf(stderr, "reflowCheck %s: later (timer active %d, %d ms)\n", qPrintable(id), it->reflowTimer->isActive(), it->reflowTimer->remainingTime()); return; }
  if (qEnvironmentVariableIsSet("MC_TERM_DEBUG")) fprintf(stderr, "reflowCheck %s: asking tmux (quiet %d)\n", qPrintable(id), quiet);
  if (!it->widget->selectedText(true).isEmpty()) { // the user is holding a selection: hands off
    if (qEnvironmentVariableIsSet("MC_TERM_DEBUG")) fprintf(stderr, "reflow %s: not looked at, text is selected\n", qPrintable(id));
    return;
  }
  c->batch({QString("display-message -p -t %1 %2").arg(it->pane, TmuxControl::quote(kFacts)), QString("capture-pane -p -e -S 0 -E - -t %1").arg(it->pane)},
           [this, id, quiet](const QList<TmuxControl::Block>& r) {
             if (qEnvironmentVariableIsSet("MC_TERM_DEBUG")) fprintf(stderr, "reflowCheck %s: reply %d blocks ok %d %d [%s]\n", qPrintable(id), int(r.size()), r.value(0).ok, r.value(1).ok, r.value(0).lines.value(0).left(60).constData());
             if (r.size() < 2 || !r[0].ok || !r[1].ok) return;
             const QByteArray facts = r[0].lines.value(0);
             const QList<QByteArray> theirs = r[1].lines;
             // The reply came after the output before it, but the widget reads that from its pty a moment later.
             QTimer::singleShot(40, this, [this, id, facts, theirs, quiet] { judgeReflow(id, facts, theirs, quiet); });
           });
}

void Host::judgeReflow(const QString& id, const QByteArray& factsLine, const QList<QByteArray>& theirs, bool quiet) {
  auto it = terms_.find(id);
  if (it == terms_.end() || !it->live) return;
  const QList<QByteArray> f = factsLine.split('\t');
  const int cols = it->widget->screenColumnsCount(), rows = it->widget->screenLinesCount();
  if (qEnvironmentVariableIsSet("MC_TERM_DEBUG")) fprintf(stderr, "reflow %s: tmux %dx%d, widget %dx%d, selected %d\n", qPrintable(id), f.value(FWidth).toInt(), f.value(FHeight).toInt(), cols, rows, int(it->widget->selectedText(true).size()));
  // tmux did not take our size (another client holds the window), or it moved on: nothing to compare.
  if (f.value(FWidth).toInt() != cols || f.value(FHeight).toInt() != rows) return;
  if (!it->widget->selectedText(true).isEmpty()) return;
  const int hist = it->widget->historyLinesCount();
  const QStringList mine = screenRows(*it, hist, hist + rows - 1);
  int differ = 0;
  for (int i = 0; i < rows; ++i) {
    QString row = drawnText(theirs.value(i));
    while (row.endsWith(' ')) row.chop(1);
    if (row != mine.value(i)) {
      ++differ;
      if (qEnvironmentVariableIsSet("MC_TERM_DEBUG") && differ <= 3) fprintf(stderr, "reflow %s: row %d\n   tmux   [%s]\n   widget [%s]\n", qPrintable(id), i, qPrintable(row), qPrintable(mine.value(i)));
    }
  }
  const int theirHist = f.value(FHistory).toInt(), limit = f.value(FLimit).toInt();
  // A pane that keeps writing differs for a moment by what is on its way: a row or two.
  const bool screens = quiet ? differ > 0 : differ > 2;
  const bool scrollback = quiet && it->skewKnown && hist - theirHist != it->histSkew;
  if (qEnvironmentVariableIsSet("MC_TERM_DEBUG"))
    fprintf(stderr, "reflow %s: %d of %d rows differ (%s), scrollback %d here, %d in tmux, skew %s%d\n", qPrintable(id), differ, rows, quiet ? "quiet" : "busy", hist, theirHist, it->skewKnown ? "" : "unknown ", it->histSkew);
  if (!screens && !scrollback) {
    if (quiet) { it->histSkew = hist - theirHist; it->skewKnown = true; }
    return;
  }
  if (it->seededGen == it->resizeGen) return; // already read again for this size: what differs now is not for another read to fix
  // tmux at its line limit has dropped lines this widget still has: keep those, redo the screen.
  // The same when the widget has gathered more than a new read would bring back.
  const bool tmuxHasAll = hist <= seedLines_ && (limit <= 0 || theirHist < limit * 0.85 || hist <= theirHist);
  if (tmuxHasAll) seed(id, false);
  else if (screens) seed(id, true);
}

// A terminal caught up: when none of its session's terminals is behind any more, tmux's
// output is read again.
void Host::resume(const QString& id) {
  auto it = terms_.find(id);
  if (it == terms_.end() || !it->native || !it->off) return;
  it->off = false;
  const QString session = it->session;
  for (const Term& t : terms_) if (t.native && t.session == session && t.off) return;
  if (TmuxControl* c = controls_.value(session)) c->setThrottled(false);
}

// Unlimited scrollback is in unnamed files on disk; past the cap, or with the disk nearly full,
// the longest history is dropped and the user told.
void Host::guardScrollback() {
  qint64 total = 0;
  const QString dir = QDir::tempPath();
  for (const QString& fd : QDir("/proc/self/fd").entryList(QDir::Files | QDir::System)) {
    char buf[1024];
    const ssize_t k = ::readlink(("/proc/self/fd/" + fd).toLocal8Bit().constData(), buf, sizeof buf - 1);
    if (k <= 0) continue;
    buf[k] = 0;
    struct stat st;
    if (strstr(buf, "(deleted)") && QString::fromLocal8Bit(buf).startsWith(dir) && ::fstat(fd.toInt(), &st) == 0 && S_ISREG(st.st_mode)) total += qint64(st.st_blocks) * 512;
  }
  struct statvfs vfs;
  const bool diskLow = ::statvfs(dir.toLocal8Bit().constData(), &vfs) == 0 && qint64(vfs.f_bavail) * qint64(vfs.f_frsize) < (2LL << 30);
  if (total <= scrollbackCap_ && !diskLow) return;
  Term* big = nullptr;
  int most = 0;
  for (Term& t : terms_) {
    const int n = t.widget->historyLinesCount();
    if (n > most) { most = n; big = &t; }
  }
  if (!big || most < 1000) return;
  big->widget->setHistorySize(0);
  big->widget->setHistorySize(scrollback_);
  const QString why = diskLow ? "the disk is nearly full" : QString("scrollback passed %1 GB").arg(scrollbackCap_ >> 30);
  statusBar()->showMessage(QString("%1: dropped the scrollback of %2 (%3 lines)").arg(why, big->title).arg(most), 20000);
  emitEvent({{"ev", "scrollback-dropped"}, {"id", big->id}, {"lines", most}, {"bytes", double(total)}});
}

void Host::closeTerm(const QString& id, bool report) {
  if (!terms_.contains(id)) return;
  Term t = terms_.take(id);
  if (activeId_ == id) activeId_.clear();
  if (t.native) {
    paneIds_.remove(t.session + ' ' + t.pane);
    bool used = false;
    for (const Term& o : terms_) if (o.native && o.session == t.session) { used = true; break; }
    if (TmuxControl* c = controls_.value(t.session)) {
      c->show(t.pane, false);
      if (!used) { controls_.remove(t.session); c->deleteLater(); }
    }
  }
  t.box->setParent(nullptr);
  t.box->deleteLater();
  if (report) emitEvent({{"ev", "closed"}, {"id", id}});
  Tab* tab = tabOf(t.tab);
  if (!tab) return;
  tab->order.removeAll(id);
  if (tab->zoomed == id) tab->zoomed.clear();
  if (tab->lastFocus == id) tab->lastFocus.clear();
  if (tab->order.isEmpty()) {
    const int i = tabs_->indexOf(tab->page);
    if (i >= 0) tabs_->removeTab(i);
    tab->page->deleteLater();
    tabsByName_.remove(t.tab);
    updateCenter();
    return;
  }
  retile(*tab);
  paintTab(*tab);
}

void Host::closeTab(const QString& name) {
  Tab* tab = tabOf(name);
  if (!tab) return;
  const QStringList ids = tab->order;
  for (const QString& id : ids) closeTerm(id, false);
}

// A tab's panes that are not minimised, in order, in groups of at most perGroup_: one
// group is on screen at a time.
QList<QStringList> Host::groups(const Tab& t) const {
  QStringList open;
  for (const QString& id : t.order) {
    auto it = terms_.constFind(id);
    if (it != terms_.constEnd() && !it->minimised) open << id;
  }
  QList<QStringList> out;
  for (int i = 0; i < open.size(); i += perGroup_) out << open.mid(i, perGroup_);
  return out;
}

QStringList Host::visible(const Tab& t) const {
  if (!t.zoomed.isEmpty() && terms_.contains(t.zoomed) && !terms_[t.zoomed].minimised) return {t.zoomed};
  const QList<QStringList> g = groups(t);
  return g.isEmpty() ? QStringList() : g[qBound(0, t.group, int(g.size()) - 1)];
}

void Host::showGroup(Tab& t, int group) {
  t.zoomed.clear();
  t.group = group;
  retile(t);
  const QStringList vis = visible(t);
  if (vis.isEmpty()) return;
  if (tree_->hasFocus()) setActive(vis.contains(t.lastFocus) ? t.lastFocus : vis.first());
  else focusTerm(vis.contains(t.lastFocus) ? t.lastFocus : vis.first());
}

// Bring a pane on screen and mark it, without giving it the keyboard: what browsing the
// project list does.
void Host::reveal(const QString& id) {
  if (!terms_.contains(id) || terms_[id].minimised) return;
  Tab* tab = tabOf(terms_[id].tab);
  if (!tab) return;
  if (!tab->zoomed.isEmpty() && tab->zoomed != id) tab->zoomed.clear();
  const QList<QStringList> g = groups(*tab);
  for (int i = 0; i < g.size(); ++i) if (g[i].contains(id)) tab->group = i;
  retile(*tab);
  tabs_->setCurrentWidget(tab->page);
  setActive(id);
}

// Rows of up to ceil(sqrt(n)) terminals, rebuilt on every change (splitter drags are lost:
// the price of never a stale layout); hidden ones stay alive.
void Host::retile(Tab& t) {
  if (!t.zoomed.isEmpty() && (!terms_.contains(t.zoomed) || terms_[t.zoomed].minimised)) t.zoomed.clear();
  const QList<QStringList> all = groups(t);
  t.group = qBound(0, t.group, qMax(0, int(all.size()) - 1));
  const QStringList show = visible(t);
  for (const QString& id : t.order) {
    if (!terms_.contains(id)) continue;
    QFrame* b = terms_[id].box;
    b->setParent(t.page);
    b->hide();
  }
  while (t.rows->count()) { QWidget* w = t.rows->widget(0); w->setParent(nullptr); w->deleteLater(); }
  const int n = show.size();
  if (n) {
    const int perRow = qCeil(qSqrt(double(n)));
    const int nRows = qCeil(double(n) / perRow);
    for (int r = 0; r < nRows; ++r) {
      auto* row = new QSplitter(Qt::Horizontal, t.rows);
      row->setChildrenCollapsible(false);
      row->setHandleWidth(1);
      for (int c = 0; c < perRow && r * perRow + c < n; ++c) {
        Term& x = terms_[show[r * perRow + c]];
        row->addWidget(x.box);
        x.box->show();
        // neighbours in the grid, either way, differ by a shade
        x.shade = alternate_ ? (r + c) % 2 : 0;
        applyTheme(x);
      }
      t.rows->addWidget(row);
    }
    // Equal cells: a splitter otherwise sizes by each child's hint, squeezing late arrivals.
    const QList<int> even(64, 10000);
    t.rows->setSizes(even.mid(0, t.rows->count()));
    for (int r = 0; r < t.rows->count(); ++r)
      if (auto* row = qobject_cast<QSplitter*>(t.rows->widget(r))) row->setSizes(even.mid(0, row->count()));
  }
  // Under the grid: the groups of panes when there is more than one (the one on screen
  // marked), and the minimised panes as buttons.
  while (QLayoutItem* item = t.stripLay->takeAt(0)) { if (item->widget()) item->widget()->deleteLater(); delete item; }
  int strips = 0;
  if (all.size() > 1) {
    for (int g = 0; g < all.size(); ++g) {
      QStringList names;
      for (const QString& id : all[g]) names << terms_[id].title + (terms_[id].attention.isEmpty() ? QString() : " " + terms_[id].attention);
      auto* b = new QToolButton(t.strip);
      b->setText(QString::number(g + 1) + "   " + names.join("  ·  "));
      b->setToolTip(QString("Panes %1 of %2: Ctrl+Shift+Tab walks through them all").arg(g + 1).arg(all.size()));
      b->setStyleSheet(theme::groupButtonStyle(QColor(t.color), g == t.group && t.zoomed.isEmpty()));
      b->setFocusPolicy(Qt::NoFocus);
      connect(b, &QToolButton::clicked, this, [this, name = t.name, g] { if (Tab* tab = tabOf(name)) showGroup(*tab, g); });
      t.stripLay->addWidget(b);
      ++strips;
    }
  }
  t.stripLay->addStretch(1);
  for (const QString& id : t.order) {
    if (!terms_.contains(id) || !terms_[id].minimised) continue;
    const Term& x = terms_[id];
    auto* b = new QToolButton(t.strip);
    b->setText(x.title + (x.attention.isEmpty() ? QString() : " " + x.attention));
    b->setToolTip("Restore " + x.title);
    b->setAutoRaise(true);
    b->setStyleSheet(theme::stripButtonStyle(QColor(x.color)));
    b->setFocusPolicy(Qt::NoFocus);
    connect(b, &QToolButton::clicked, this, [this, id] { setMinimised(id, false); });
    t.stripLay->addWidget(b);
    ++strips;
  }
  t.strip->setVisible(strips > 0);
  for (const QString& id : show) paintHeader(terms_[id]);
  if (tabs_->currentWidget() == t.page && !tree_->hasFocus()) focusCurrent();
}

void Host::paintHeader(Term& t) {
  const bool active = activeId_ == t.id;
  const Tab* tab = tabOf(t.tab);
  QString text = active ? "<b>" + t.title.toHtmlEscaped() + "</b>" : t.title.toHtmlEscaped();
  if (!t.attention.isEmpty()) text += QString("&nbsp;&nbsp;<span style='color:%1'>%2</span>").arg(t.attention.contains('!') ? "#ff7a85" : "#ffd27a", t.attention.toHtmlEscaped());
  if (tab && tab->zoomed == t.id) text += "&nbsp;&nbsp;<span style='font-weight:normal'>[zoomed]</span>";
  t.header->setText(text);
  t.header->setStyleSheet(theme::headerStyle(QColor(t.color), active));
}

// A pane's text size: the window's font, `step` points bigger or smaller. The program
// gets the new size (fewer or more cells) through the usual resize.
void Host::setTextStep(Term& t, int step, bool report) {
  bool bold = true;
  QFont f = termFont(&bold);
  step = qBound(-(qMax(1, int(f.pointSizeF())) - 4), step, 40);
  t.textStep = step;
  if (step) f.setPointSizeF(f.pointSizeF() + step);
  t.widget->setTerminalFont(f);
  if (t.resizeTimer) { t.resizePending = true; t.resizeTimer->start(); }
  if (report) emitEvent({{"ev", "pane-text"}, {"id", t.id}, {"step", step}});
}

// A terminal's colours: a named scheme if one is set, else ours, with its project's hue
// (the tab's colour; its own when the tab has none) and the shade its place in the grid gives.
void Host::applyTheme(Term& t) {
  QString key, name;
  if (!t.ownScheme.isEmpty()) key = name = t.ownScheme;
  else if (!scheme_.isEmpty()) key = name = scheme_;
  else {
    const Tab* tab = tabOf(t.tab);
    const QColor project(tab && !tab->color.isEmpty() ? tab->color : t.color);
    name = theme::scheme(project, t.shade, tint_);
    key = name;
  }
  if (key == t.schemeKey || name.isEmpty()) return;
  t.schemeKey = key;
  t.widget->setColorScheme(name);
  // margins come from the palette, which Qt resets on every polish under an application style
  // sheet: a style sheet of the widget's own is what holds
  if (QWidget* display = t.widget->focusProxy()) {
    const QColor bg = display->palette().window().color(); // as the widget itself just set it
    display->setStyleSheet(QString("Konsole--TerminalDisplay { background-color: %1; }").arg(bg.name()));
    // The scrollbar is drawn over the terminal's own background, not on a strip of its own.
    for (QScrollBar* bar : display->findChildren<QScrollBar*>()) bar->setAutoFillBackground(false);
  }
  t.widget->setTerminalOpacity(1.0 - transparency_);
}

// See-through terminals over an empty window; with transparency off the middle fills itself,
// so no seam shows the desktop. The blur is KWin's (an X11 window property).
void Host::applyTransparency() {
  const bool on = transparency_ > 0;
  center_->setAutoFillBackground(!on);
  for (Term& t : terms_) { t.widget->setTerminalOpacity(1.0 - transparency_); if (QWidget* d = t.widget->focusProxy()) d->update(); }
  update();
#ifdef MC_HAVE_XCB
  auto* x11 = qGuiApp->nativeInterface<QNativeInterface::QX11Application>();
  if (!x11 || !x11->connection() || !windowHandle()) return;
  xcb_connection_t* c = x11->connection();
  static const char name[] = "_KDE_NET_WM_BLUR_BEHIND_REGION";
  xcb_intern_atom_reply_t* atom = xcb_intern_atom_reply(c, xcb_intern_atom(c, 0, sizeof name - 1, name), nullptr);
  if (!atom) return;
  const xcb_window_t win = xcb_window_t(winId());
  if (on && blur_) xcb_change_property(c, XCB_PROP_MODE_REPLACE, win, atom->atom, XCB_ATOM_CARDINAL, 32, 0, nullptr); // no rectangles: the whole window
  else xcb_delete_property(c, win, atom->atom);
  xcb_flush(c);
  free(atom);
#endif
}

void Host::paintTab(const Tab& t) {
  const int i = tabs_->indexOf(t.page);
  if (i < 0) return;
  QString marks;
  for (const QString& id : t.order) if (terms_.contains(id) && !terms_[id].attention.isEmpty()) marks += terms_[id].attention;
  tabs_->setTabText(i, t.name + (marks.isEmpty() ? QString() : " " + marks));
  // the project's colour as a dot, as in the sidebar
  if (!t.color.isEmpty()) tabs_->setTabIcon(i, dotIcon("full", QColor(t.color)));
  if (!t.color.isEmpty() && tabs_->currentIndex() == i) tabs_->tabBar()->setStyleSheet(QString("QTabBar::tab:selected { border-bottom: 2px solid %1; }").arg(QColor(t.color).name()));
}

// The pane the keyboard was last in keeps its bright header while focus is elsewhere
// (the sidebar, a dialog), like tmux's active pane.
void Host::setActive(const QString& id) {
  if (!terms_.contains(id)) return;
  if (Tab* tab = tabOf(terms_[id].tab)) tab->lastFocus = id;
  if (activeId_ == id) return;
  const QString old = activeId_;
  activeId_ = id;
  if (terms_.contains(old)) paintHeader(terms_[old]);
  paintHeader(terms_[id]);
  // the project list marks the pane the keyboard is in
  if (!tree_->hasFocus()) {
    if (QTreeWidgetItem* it = nodeItems_.value(terms_[id].node)) { tree_->blockSignals(true); tree_->setCurrentItem(it); tree_->blockSignals(false); }
  }
  emitEvent({{"ev", "focused"}, {"id", id}, {"tab", terms_[id].tab}});
}

void Host::focusTerm(const QString& id) {
  if (!terms_.contains(id)) return;
  Tab* tab = tabOf(terms_[id].tab);
  if (!tab) return;
  if (terms_[id].minimised) { setMinimised(id, false); return; }
  bool again = false;
  if (!tab->zoomed.isEmpty() && tab->zoomed != id) { tab->zoomed.clear(); again = true; }
  const QList<QStringList> g = groups(*tab);
  for (int i = 0; i < g.size(); ++i) if (g[i].contains(id) && tab->group != i) { tab->group = i; again = true; }
  if (again) retile(*tab);
  tabs_->setCurrentWidget(tab->page);
  terms_[id].widget->setFocus();
}

QString Host::currentTermId() {
  Tab* tab = currentTab();
  if (!tab) return QString();
  const QStringList vis = visible(*tab);
  if (vis.contains(activeId_)) return activeId_;
  if (vis.contains(tab->lastFocus)) return tab->lastFocus;
  return vis.value(0);
}

void Host::focusCurrent() {
  const QString id = currentTermId();
  if (id.isEmpty()) return;
  terms_[id].widget->setFocus();
  // marked as the current pane even while the window itself is not the active one
  if (activeId_ != id && !tree_->hasFocus()) setActive(id);
}

void Host::toggleZoom(const QString& id) {
  if (!terms_.contains(id)) return;
  Tab* tab = tabOf(terms_[id].tab);
  if (!tab) return;
  tab->zoomed = tab->zoomed == id ? QString() : id;
  tab->lastFocus = id;
  retile(*tab);
  focusTerm(id);
}

void Host::setMinimised(const QString& id, bool on) {
  if (!terms_.contains(id) || terms_[id].minimised == on) return;
  Tab* tab = tabOf(terms_[id].tab);
  if (!tab) return;
  terms_[id].minimised = on;
  if (on) {
    if (tab->zoomed == id) tab->zoomed.clear();
    if (tab->lastFocus == id) tab->lastFocus.clear();
    if (activeId_ == id) activeId_.clear();
  } else tab->lastFocus = id;
  retile(*tab);
  if (!on) focusTerm(id);
  emitEvent({{"ev", "minimised"}, {"id", id}, {"on", on}});
}

void Host::cycleTab(int step) {
  const int n = tabs_->count();
  if (n < 2) return;
  tabs_->setCurrentIndex(((tabs_->currentIndex() + step) % n + n) % n);
  focusCurrent();
}

void Host::cyclePane(int step) {
  Tab* tab = currentTab();
  if (!tab) return;
  // through every pane of the tab, one group after the other
  QStringList all;
  for (const QStringList& g : groups(*tab)) all << g;
  if (all.isEmpty()) return;
  const int i = all.indexOf(currentTermId());
  const int n = all.size();
  focusTerm(all[((qMax(0, i) + step) % n + n) % n]);
}

// Arrow-wise through the grid as it is drawn.
void Host::movePane(int dx, int dy) {
  Tab* tab = currentTab();
  if (!tab) return;
  const QStringList vis = visible(*tab);
  const int n = vis.size();
  const int i = vis.indexOf(currentTermId());
  if (n < 2 || i < 0) return;
  const int perRow = qCeil(qSqrt(double(n)));
  int row = i / perRow, col = i % perRow;
  const int rows = qCeil(double(n) / perRow);
  if (dx) {
    const int inRow = qMin(perRow, n - row * perRow);
    col = ((col + dx) % inRow + inRow) % inRow;
  } else {
    row = ((row + dy) % rows + rows) % rows;
    col = qMin(col, qMin(perRow, n - row * perRow) - 1);
  }
  focusTerm(vis[row * perRow + col]);
}

// ---- sidebar -------------------------------------------------------------------------

QString Host::currentNode() const {
  QTreeWidgetItem* it = tree_->currentItem();
  return it ? it->data(0, Qt::UserRole).toString() : QString();
}

void Host::selectNode(const QString& id) {
  if (QTreeWidgetItem* it = nodeItems_.value(id)) tree_->setCurrentItem(it);
}

// The whole tree, replaced: it is small, and the driver sends it only when it changed.
// What the user did to it (the selection, which branches are folded) survives.
void Host::setTree(const QJsonArray& nodes) {
  const QString selected = currentNode();
  const bool hadFocus = tree_->hasFocus();
  tree_->setUpdatesEnabled(false);
  tree_->blockSignals(true);
  tree_->clear();
  nodeActions_.clear();
  nodeItems_.clear();
  std::function<void(QTreeWidgetItem*, const QJsonObject&)> add = [&](QTreeWidgetItem* parent, const QJsonObject& n) {
    auto* it = parent ? new QTreeWidgetItem(parent) : new QTreeWidgetItem(tree_);
    const QString id = n.value("id").toString();
    it->setData(0, Qt::UserRole, id);
    it->setText(0, n.value("label").toString());
    it->setText(1, n.value("badge").toString());
    it->setToolTip(0, n.value("tooltip").toString());
    if (n.contains("color")) it->setForeground(0, QColor(n.value("color").toString()));
    if (n.contains("badgeColor")) it->setForeground(1, QColor(n.value("badgeColor").toString()));
    if (n.value("bold").toBool()) { QFont f = it->font(0); f.setBold(true); it->setFont(0, f); }
    if (n.value("dim").toBool()) it->setForeground(0, palette().color(QPalette::Disabled, QPalette::Text));
    it->setIcon(0, dotIcon(n.value("dot").toString(), QColor(n.value("dotColor").toString("#888888"))));
    nodeActions_.insert(id, n.value("actions").toArray());
    nodeItems_.insert(id, it);
    for (const auto& c : n.value("children").toArray()) add(it, c.toObject());
    it->setExpanded(!collapsed_.contains(id));
  };
  for (const auto& n : nodes) add(nullptr, n.toObject());
  // What was selected stays selected; when the keyboard is in a pane, its entry is (it may
  // only now exist: a new pane is named before the list knows it).
  QTreeWidgetItem* keep = nodeItems_.value(selected);
  if (!hadFocus && terms_.contains(activeId_)) if (QTreeWidgetItem* mine = nodeItems_.value(terms_[activeId_].node)) keep = mine;
  if (keep) tree_->setCurrentItem(keep);
  tree_->blockSignals(false);
  tree_->setUpdatesEnabled(true);
  if (hadFocus) tree_->setFocus();
}

// A node's actions as a menu; for a pane's header also what the window itself can do to it.
void Host::showNodeMenu(const QString& node, const QPoint& globalPos, const QString& termId) {
  QMenu m(this);
  if (!termId.isEmpty() && terms_.contains(termId)) {
    const Tab* tab = tabOf(terms_[termId].tab);
    // paste first: right-click, then the top item (selecting already copied)
    connect(m.addAction("Paste"), &QAction::triggered, this, [this, termId] { if (terms_.contains(termId)) terms_[termId].widget->pasteClipboard(); });
    connect(m.addAction("Copy"), &QAction::triggered, this, [this, termId] { if (terms_.contains(termId)) terms_[termId].widget->copyClipboard(); });
    m.addSeparator();
    connect(m.addAction(tab && tab->zoomed == termId ? "Unzoom" : "Zoom"), &QAction::triggered, this, [this, termId] { toggleZoom(termId); });
    connect(m.addAction("Minimise"), &QAction::triggered, this, [this, termId] { setMinimised(termId, true); });
    {
      // this pane's colours: the window's (tinted by the project), or a scheme of its own
      QMenu* sub = m.addMenu("Colour scheme");
      const QString have = terms_[termId].ownScheme;
      QStringList names{QString()};
      QStringList all = QTermWidget::availableColorSchemes();
      all.sort(Qt::CaseInsensitive);
      for (const QString& n : all) if (!n.startsWith("mc-")) names << n;
      for (const QString& n : names) {
        QAction* a = sub->addAction(n.isEmpty() ? QString("The window's (project colour)") : n);
        a->setCheckable(true);
        a->setChecked(n == have);
        connect(a, &QAction::triggered, this, [this, termId, n] {
          if (!terms_.contains(termId)) return;
          terms_[termId].ownScheme = n;
          applyTheme(terms_[termId]);
          emitEvent({{"ev", "pane-scheme"}, {"id", termId}, {"node", terms_[termId].node}, {"scheme", n}});
        });
        if (n.isEmpty()) sub->addSeparator();
      }
    }
    if (terms_[termId].native) connect(m.addAction("Find in scrollback…"), &QAction::triggered, this, [this, termId] { if (terms_.contains(termId)) terms_[termId].widget->toggleShowSearchBar(); });
    m.addSeparator();
  }
  for (const auto& v : nodeActions_.value(node)) {
    const QJsonObject a = v.toObject();
    if (a.value("separator").toBool()) { m.addSeparator(); continue; }
    const QString key = a.value("key").toString();
    QAction* act = m.addAction(a.value("label").toString() + (key.isEmpty() ? QString() : "\t" + key));
    act->setEnabled(a.value("enabled").toBool(true));
    const QString id = a.value("id").toString();
    connect(act, &QAction::triggered, this, [this, id, node, termId] { emitEvent({{"ev", "action"}, {"action", id}, {"node", node}, {"id", termId}}); });
  }
  if (!m.isEmpty()) m.exec(globalPos);
}

// To the project list, on the entry of the pane the keyboard was in (its project's when
// that pane has none), or from the list back to the pane.
void Host::sidebarFocus() {
  if (tree_->hasFocus()) { focusCurrent(); return; }
  dock_->show();
  tree_->blockSignals(true);
  const QString cur = currentTermId();
  QTreeWidgetItem* at = terms_.contains(cur) ? nodeItems_.value(terms_[cur].node) : nullptr;
  if (!at) if (Tab* tab = currentTab()) {
    for (auto it = nodeItems_.begin(); it != nodeItems_.end(); ++it)
      if (!it.value()->parent() && it.value()->text(0) == tab->name) { at = it.value(); break; }
  }
  if (at) tree_->setCurrentItem(at);
  tree_->blockSignals(false);
  if (!tree_->currentItem() && tree_->topLevelItemCount()) tree_->setCurrentItem(tree_->topLevelItem(0));
  tree_->setFocus();
}

// Keys in the sidebar: Esc goes back to the pane, Enter activates, and a single letter
// runs the selected entry's action with that key (the old menu's a, x, u, d...).
bool Host::eventFilter(QObject* o, QEvent* e) {
  if ((e->type() == QEvent::KeyPress || e->type() == QEvent::KeyRelease) && o->isWidgetType() && static_cast<QWidget*>(o)->window() == this) {
    auto* k = static_cast<QKeyEvent*>(e);
    if (k->key() == Qt::Key_Alt && !k->isAutoRepeat()) {
      if (e->type() == QEvent::KeyPress) altTimer_->start();
      else { altTimer_->stop(); if (!menuPersist_ && menuBar()->isVisible()) menuHide_->start(); }
    } else if (e->type() == QEvent::KeyPress && k->key() != Qt::Key_Alt) altTimer_->stop(); // Alt+key: a shortcut, not a request
  }
  // F1, anywhere in the window: tapped, the shortcut bar comes and goes; held, every
  // key is also shown where it acts (on the tabs, the panes, the list) until let go.
  if ((e->type() == QEvent::KeyPress || e->type() == QEvent::KeyRelease) && o->isWidgetType() && static_cast<QWidget*>(o)->window() == this) {
    auto* k = static_cast<QKeyEvent*>(e);
    if (k->key() == Qt::Key_F1 && k->modifiers() == Qt::NoModifier) {
      if (k->isAutoRepeat()) return true;
      if (e->type() == QEvent::KeyPress) { f1Held_ = false; f1Hold_->start(); }
      else {
        if (f1Hold_->isActive()) { f1Hold_->stop(); keyBar_->isVisible() ? hideKeyBar() : showKeyBar(); }
        else if (f1Held_) { hideBadges(); f1Held_ = false; }
      }
      return true;
    }
  }
  if (e->type() == QEvent::KeyPress && o != tree_ && o->property("mcDisplay").isValid()) {
    // Qt would move the focus on Tab and Shift+Tab; in a terminal they are the program's keys
    auto* k = static_cast<QKeyEvent*>(e);
    if ((k->key() == Qt::Key_Tab || k->key() == Qt::Key_Backtab) && !(k->modifiers() & (Qt::ControlModifier | Qt::AltModifier | Qt::MetaModifier))) {
      auto it = terms_.find(o->property("mcDisplay").toString());
      if (it != terms_.end()) { it->widget->sendKeyEvent(k); return true; }
    }
    return false;
  }
  if ((e->type() == QEvent::Resize || e->type() == QEvent::Show) && o != tree_ && o->property("mcDisplay").isValid()) {
    auto it = terms_.find(o->property("mcDisplay").toString());
    if (it != terms_.end() && it->redrawTimer) it->redrawTimer->start();
    return false;
  }
  if (e->type() == QEvent::Resize && o != tree_) {
    auto it = terms_.find(o->property("mcId").toString());
    if (it != terms_.end() && it->resizeTimer) { it->resizePending = true; it->resizeTimer->start(it->seeded ? 40 : 150); }
    return false;
  }
  if (o == tree_ && e->type() == QEvent::KeyPress) {
    auto* k = static_cast<QKeyEvent*>(e);
    if (k->key() == Qt::Key_Escape) { focusCurrent(); return true; }
    const QString node = currentNode();
    if (k->key() == Qt::Key_Return || k->key() == Qt::Key_Enter) {
      if (!node.isEmpty()) emitEvent({{"ev", "activate"}, {"node", node}});
      return true;
    }
    const QString ch = k->text();
    if (ch.size() == 1 && ch[0].isPrint() && !ch[0].isSpace() && !(k->modifiers() & (Qt::ControlModifier | Qt::AltModifier | Qt::MetaModifier))) {
      for (const auto& v : nodeActions_.value(node)) {
        const QJsonObject a = v.toObject();
        if (a.value("key").toString() == ch && a.value("enabled").toBool(true)) {
          emitEvent({{"ev", "action"}, {"action", a.value("id").toString()}, {"node", node}, {"id", QString()}});
          return true;
        }
      }
      if (sidebarKeys_.contains(ch)) { runAction(sidebarKeys_.value(ch)); return true; }
    }
  }
  return QMainWindow::eventFilter(o, e);
}

// ---- menus, actions, dialogs ---------------------------------------------------------

void Host::setMenus(const QJsonArray& menus) {
  if (menus == menus_ && !menus.isEmpty()) return;
  menus_ = menus;
  menuBar()->clear();
  for (QAction* a : actions_) { removeAction(a); a->deleteLater(); }
  actions_.clear();
  sidebarKeys_.clear();
  for (const auto& mv : menus) {
    const QJsonObject mo = mv.toObject();
    QMenu* menu = menuBar()->addMenu(mo.value("title").toString());
    for (const auto& iv : mo.value("items").toArray()) {
      const QJsonObject item = iv.toObject();
      if (item.value("separator").toBool()) { menu->addSeparator(); continue; }
      if (item.contains("items")) { // a submenu, one level deep
        QMenu* sub = menu->addMenu(item.value("label").toString());
        for (const auto& sv : item.value("items").toArray()) {
          const QJsonObject si = sv.toObject();
          if (si.value("separator").toBool()) { sub->addSeparator(); continue; }
          const QString sid = si.value("id").toString();
          connect(sub->addAction(si.value("label").toString()), &QAction::triggered, this, [this, sid] { runAction(sid); });
        }
        continue;
      }
      const QString id = item.value("id").toString();
      auto* a = new QAction(item.value("label").toString(), this);
      a->setData(id);
      QList<QKeySequence> keys;
      if (item.contains("shortcut")) keys << QKeySequence(item.value("shortcut").toString());
      for (const auto& s : item.value("shortcuts").toArray()) keys << QKeySequence(s.toString());
      a->setShortcuts(keys);
      a->setShortcutContext(Qt::WindowShortcut);
      connect(a, &QAction::triggered, this, [this, id] { runAction(id); });
      menu->addAction(a);
      addAction(a); // the shortcut works whatever has focus, menu bar shown or not
      actions_ << a;
      if (item.contains("key")) sidebarKeys_.insert(item.value("key").toString(), id);
    }
  }
}

// host.* is done here; anything else is the driver's, told where the user was.
void Host::runAction(const QString& id) {
  if (id.startsWith("host.")) { local(id); return; }
  Tab* tab = currentTab();
  emitEvent({{"ev", "action"}, {"action", id}, {"id", tree_->hasFocus() ? QString() : currentTermId()}, {"tab", tab ? tab->name : QString()},
             {"node", currentNode()}, {"focus", tree_->hasFocus() ? "tree" : "term"}});
}

void Host::local(const QString& a) {
  const QString cur = currentTermId();
  if (a == "host.tab-next") cycleTab(1);
  else if (a == "host.tab-prev") cycleTab(-1);
  else if (a == "host.pane-next") cyclePane(1);
  else if (a == "host.pane-prev") cyclePane(-1);
  else if (a == "host.pane-left") movePane(-1, 0);
  else if (a == "host.pane-right") movePane(1, 0);
  else if (a == "host.pane-up") movePane(0, -1);
  else if (a == "host.pane-down") movePane(0, 1);
  else if (a == "host.zoom") toggleZoom(cur);
  else if (a == "host.minimise") setMinimised(cur, true);
  else if (a == "host.restore") {
    if (Tab* tab = currentTab()) { const QStringList ids = tab->order; for (const QString& id : ids) setMinimised(id, false); }
  }
  else if (a == "host.sidebar") sidebarFocus();
  else if (a == "host.sidebar-toggle") dock_->setVisible(!dock_->isVisible());
  else if (a == "host.paste") { if (terms_.contains(cur)) terms_[cur].widget->pasteClipboard(); }
  else if (a == "host.copy") { if (terms_.contains(cur)) terms_[cur].widget->copyClipboard(); }
  else if (a == "host.find") { if (terms_.contains(cur)) terms_[cur].widget->toggleShowSearchBar(); }
  else if (a == "host.clear-scrollback") { if (terms_.contains(cur)) { terms_[cur].widget->setHistorySize(0); terms_[cur].widget->setHistorySize(terms_[cur].native ? scrollback_ : 0); } }
  else if (a == "host.scroll-end") { if (terms_.contains(cur)) terms_[cur].widget->scrollToEnd(); }
  // per pane: just the terminal with the keyboard (its program sees the new size)
  else if (a == "host.pane-text-bigger") { if (terms_.contains(cur)) setTextStep(terms_[cur], terms_[cur].textStep + 1, true); }
  else if (a == "host.pane-text-smaller") { if (terms_.contains(cur)) setTextStep(terms_[cur], terms_[cur].textStep - 1, true); }
  else if (a == "host.pane-text-reset") { if (terms_.contains(cur)) setTextStep(terms_[cur], 0, true); }
  else if (a == "host.font-bigger") { ++fontSize_; applyFont(); }
  else if (a == "host.font-smaller") { fontSize_ = qMax(6, fontSize_ - 1); applyFont(); }
  else if (a == "host.font-reset") { fontSize_ = baseFontSize_; applyFont(); }
  else if (a == "host.fullscreen") setWindowState(windowState() ^ Qt::WindowFullScreen);
  else if (a == "host.settings") openSettings();
  else if (a == "host.driver-restart") {
    driverStarts_.clear();
    if (driver_) driver_->terminate(); // comes back through driverExited()
    else startDriver();
  }
  else if (a == "host.quit") close();
}

// A question for the user; the answer goes out as an event. Not exec(): several can be
// open, and nothing here may block the socket.
void Host::ask(const QJsonObject& m) {
  const QString id = m.value("id").toString();
  if (asks_.contains(id)) return;
  auto* d = new FormDialog(m, this);
  d->setAttribute(Qt::WA_DeleteOnClose);
  asks_.insert(id, d);
  connect(d, &QDialog::finished, this, [this, id, d](int result) {
    asks_.remove(id);
    if (result == QDialog::Accepted) emitEvent({{"ev", "answer"}, {"id", id}, {"values", d->values()}});
    else emitEvent({{"ev", "answer"}, {"id", id}, {"cancelled", true}});
  });
  d->open();
}

void Host::openSettings() {
  if (settingsSchema_.isEmpty()) {
    emitEvent({{"ev", "settings-open"}});
    statusBar()->showMessage("no settings loaded yet (the driver sends them)", 4000);
    return;
  }
  if (asks_.contains("settings")) { asks_.value("settings")->raise(); return; }
  auto* d = new FormDialog(QJsonObject{{"title", "Settings"}, {"schema", settingsSchema_}, {"values", settingsValues_}, {"ok", "Save"}}, this);
  d->setAttribute(Qt::WA_DeleteOnClose);
  asks_.insert("settings", d);
  connect(d, &QDialog::finished, this, [this, d](int result) {
    asks_.remove("settings");
    if (result != QDialog::Accepted) return;
    settingsValues_ = d->values();
    emitEvent({{"ev", "settings"}, {"values", settingsValues_}});
  });
  d->open();
}

// The show/hide key as a KDE global shortcut of this running window; with it closed, the
// launcher entry from `my-claude --install` has the key.
namespace {
using KeyList = QList<int>;
using KeyLists = QList<KeyList>;
}
Q_DECLARE_METATYPE(KeyList)
Q_DECLARE_METATYPE(KeyLists)

void Host::registerGlobalKey() {
  // The key is this machine's window's. Every window would get each press and flip itself,
  // so with a second (--remote) window open one would hide as the other showed.
  if (!remote_.isEmpty()) return;
  QDBusConnection bus = QDBusConnection::sessionBus();
  if (!bus.isConnected()) return;
  QDBusInterface accel("org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel", bus);
  if (!accel.isValid()) return;
  qDBusRegisterMetaType<KeyList>();
  qDBusRegisterMetaType<KeyLists>();
  const QKeySequence seq(toggleKey_.isEmpty() ? qEnvironmentVariable("MC_TERM_TOGGLE_KEY", "Ctrl+Alt+T") : toggleKey_);
  if (seq.isEmpty()) return;
  const int key = seq[0].toCombined();
  const QStringList id = {"mc-term", "toggle", "my-claude", "Show or hide my-claude"};
  // a launcher entry holding the key while this window runs would take it first
  // (flags: SetPresent 2 makes the action live, NoAutoloading 4 takes our keys over saved ones)
  accel.call("setShortcut", QStringList{"mc-term-toggle.desktop", "_launch", "my-claude (show/hide)", "Launch"}, QVariant::fromValue(KeyList{}), 4u);
  // whoever else holds the key (a drop-down terminal, say) lets go of it: KDE gives a key
  // to its first claimant only
  for (int i = 0; i < 2; ++i) {
    const QDBusMessage owner = accel.call("action", key);
    const QStringList who = owner.arguments().value(0).toStringList();
    if (who.size() < 2 || who[0] == "mc-term") break;
    accel.call("setForeignShortcut", who, QVariant::fromValue(KeyList{}));
    accel.call("setShortcut", who, QVariant::fromValue(KeyList{}), 4u);
  }
  accel.call("doRegister", id);
  const QDBusMessage r = accel.call("setShortcut", id, QVariant::fromValue(KeyList{key}), 6u);
  if (r.type() == QDBusMessage::ErrorMessage) qWarning("mc-term: global key not registered: %s", qPrintable(r.errorMessage()));
  bus.connect("org.kde.kglobalaccel", "/component/mc_term", "org.kde.kglobalaccel.Component", "globalShortcutPressed", this, SLOT(onGlobalShortcut(QString,QString,qlonglong)));
}

void Host::onGlobalShortcut(const QString& component, const QString& shortcut, qlonglong) {
  if (component != "mc-term" || shortcut != "toggle") return;
  if (isVisible() && isActiveWindow() && !(windowState() & Qt::WindowMinimized)) { hide(); return; }
  showInFront();
}

// Up front, full screen, with the keyboard: asked as a pager asks (_NET_ACTIVE_WINDOW source 2),
// which focus-stealing prevention lets through.
void Host::revealFirst() {
  if (revealed_) return;
  revealed_ = true;
  if (startHidden_) return; // started for show/hide: that request shows it
  show();
}

void Host::showInFront() {
  revealed_ = true;
  // Wayland lets no window take the focus by itself, but focuses one mapped anew: so a window
  // on screen without the focus is shown again rather than raised
  if (QGuiApplication::platformName() == "wayland" && isVisible() && !isActiveWindow()) {
    hide();
    QTimer::singleShot(40, this, [this] { showFullScreen(); raise(); activateWindow(); focusCurrent(); });
    return;
  }
  showFullScreen();
  raise();
  activateWindow();
#ifdef MC_HAVE_XCB
  if (auto* x11 = qGuiApp->nativeInterface<QNativeInterface::QX11Application>()) {
    xcb_connection_t* c = x11->connection();
    static const char name[] = "_NET_ACTIVE_WINDOW";
    if (xcb_intern_atom_reply_t* atom = xcb_intern_atom_reply(c, xcb_intern_atom(c, 0, sizeof name - 1, name), nullptr)) {
      xcb_client_message_event_t ev{};
      ev.response_type = XCB_CLIENT_MESSAGE;
      ev.format = 32;
      ev.window = xcb_window_t(winId());
      ev.type = atom->atom;
      ev.data.data32[0] = 2; // source: pager
      ev.data.data32[1] = XCB_CURRENT_TIME;
      xcb_screen_t* screen = xcb_setup_roots_iterator(xcb_get_setup(c)).data;
      xcb_send_event(c, 0, screen->root, XCB_EVENT_MASK_SUBSTRUCTURE_REDIRECT | XCB_EVENT_MASK_SUBSTRUCTURE_NOTIFY, reinterpret_cast<const char*>(&ev));
      xcb_flush(c);
      free(atom);
    }
  }
#endif
  focusCurrent();
}

// The keys of what has the focus: in the project list its single letters and the
// selected entry's actions; everywhere, the menus' shortcuts.
void Host::showKeyBar() {
  const auto esc = [](const QString& x) { return x.toHtmlEscaped(); };
  QStringList parts;
  const auto add = [&](const QString& keys, const QString& what) { parts << QString("<span style='color:#ffd27a'>%1</span>&nbsp;%2").arg(esc(keys), esc(what)); };
  QString where = "this pane";
  if (tree_->hasFocus()) {
    where = "the project list";
    add("↑↓", "walk");
    add("Enter", "go / start");
    add("Esc", "back to the pane");
    for (const auto& v : nodeActions_.value(currentNode())) {
      const QJsonObject a = v.toObject();
      if (!a.value("key").toString().isEmpty() && a.value("enabled").toBool(true)) add(a.value("key").toString(), a.value("label").toString());
    }
    for (auto it = sidebarKeys_.begin(); it != sidebarKeys_.end(); ++it)
      for (QAction* act : actions_) if (act->data().toString() == it.value()) add(it.key(), act->text().remove('&').remove(QChar(0x2026)));
  }
  for (QAction* act : actions_) {
    if (act->shortcuts().isEmpty()) continue;
    QStringList ks;
    for (const QKeySequence& k : act->shortcuts()) ks << k.toString(QKeySequence::NativeText);
    add(ks.join(" "), act->text().remove('&').remove(QChar(0x2026)));
  }
  add("F1", "this bar  (hold: every key where it acts)");
  keyBar_->setText(QString("<span style='color:#8d93a3'>keys · %1</span>&nbsp;&nbsp; %2").arg(esc(where), parts.join("&nbsp;&nbsp;<span style='color:#5c6272'>│</span>&nbsp;&nbsp;")));
  bool bold = true;
  QFont f = termFont(&bold);
  f.setPointSizeF(qMax(8.0, f.pointSizeF() - 1));
  keyBar_->setFont(f);
  keyBar_->setStyleSheet("QLabel#keybar { background: rgba(10,12,16,235); color: #d4d8e1; border-top: 1px solid #6ea8fe; padding: 6px 10px; }");
  auto* fx = new QGraphicsOpacityEffect(keyBar_);
  fx->setOpacity(1.0);
  keyBar_->setGraphicsEffect(fx);
  placeKeyBar();
  keyBar_->show();
  keyBar_->raise();
  keyBarTimer_->start();
}

void Host::hideKeyBar() {
  keyBarTimer_->stop();
  auto* fx = qobject_cast<QGraphicsOpacityEffect*>(keyBar_->graphicsEffect());
  if (!fx || !keyBar_->isVisible()) { keyBar_->hide(); return; }
  auto* anim = new QPropertyAnimation(fx, "opacity", keyBar_);
  anim->setDuration(900);
  anim->setStartValue(1.0);
  anim->setEndValue(0.0);
  connect(anim, &QPropertyAnimation::finished, keyBar_, &QWidget::hide);
  anim->start(QAbstractAnimation::DeleteWhenStopped);
}

void Host::placeKeyBar() {
  const int w = width();
  keyBar_->setFixedWidth(w);
  const int h = keyBar_->heightForWidth(w);
  const int bottom = statusBar()->isVisible() ? statusBar()->y() : height();
  keyBar_->setGeometry(0, bottom - h, w, h);
}

void Host::resizeEvent(QResizeEvent* e) {
  QMainWindow::resizeEvent(e);
  if (keyBar_ && keyBar_->isVisible()) placeKeyBar();
}

// Every key where it acts, as small tags: on the tab bar, on each pane on screen (how to
// reach it from the pane with the keyboard), on the project list.
// The first key bound to a menu action, as the user has it now; empty when it has none.
QString Host::keyFor(const QString& action) const {
  for (QAction* a : actions_)
    if (a->data().toString() == action && !a->shortcut().isEmpty()) return a->shortcut().toString(QKeySequence::NativeText);
  return {};
}

void Host::showBadges() {
  hideBadges();
  const auto tag = [this](QWidget* over, const QString& text, Qt::Alignment where) {
    if (!over || !over->isVisible() || text.isEmpty()) return;
    auto* b = new QLabel(text, this);
    b->setAttribute(Qt::WA_TransparentForMouseEvents);
    bool bold = true;
    QFont f = termFont(&bold);
    f.setPointSizeF(qMax(8.0, f.pointSizeF() - 1));
    f.setBold(true);
    b->setFont(f);
    b->setStyleSheet("QLabel { background: #ffd27a; color: #101214; border-radius: 4px; padding: 2px 7px; }");
    b->adjustSize();
    const QRect r(over->mapTo(this, QPoint(0, 0)), over->size());
    QPoint p = r.center() - QPoint(b->width() / 2, b->height() / 2);
    if (where & Qt::AlignTop) p.setY(r.top() + 4);
    if (where & Qt::AlignRight) p.setX(r.right() - b->width() - 6);
    if (where & Qt::AlignLeft) p.setX(r.left() + 6);
    b->move(p);
    b->show();
    b->raise();
    badges_ << b;
  };
  // the keys as bound now (Settings → Shortcuts), so a rebound key is shown as it is
  const auto k = [this](const char* action, const QString& what, const char* sep = "  ") {
    const QString key = keyFor(action);
    return key.isEmpty() ? QString() : key + sep + what;
  };
  const auto join = [](QStringList parts, const char* sep) { parts.removeAll(QString()); return parts.join(sep); };
  tag(tabs_->tabBar(), k("host.tab-next", "next project"), Qt::AlignRight | Qt::AlignTop);
  tag(tree_, join({k("host.sidebar", "list"), k("host.sidebar-toggle", "hide")}, "    "), Qt::AlignTop | Qt::AlignHCenter);
  if (Tab* t = currentTab()) {
    const QStringList vis = visible(*t);
    const QString cur = currentTermId();
    const int n = vis.size(), perRow = qMax(1, int(qCeil(qSqrt(double(qMax(1, n))))));
    const int ci = vis.indexOf(cur);
    for (int i = 0; i < n; ++i) {
      const Term& x = terms_[vis[i]];
      QString how;
      if (vis[i] == cur) how = join({"here", k("pane.close", "close", " "), k("host.zoom", "zoom", " "), k("host.pane-text-bigger", "text", " ")}, " · ");
      else if (ci >= 0) {
        // one step in a straight line has a key of its own; anything else is so many "next"s
        const int dr = i / perRow - ci / perRow, dc = i % perRow - ci % perRow;
        const char* dir = dc == 0 ? (dr < 0 ? "host.pane-up" : "host.pane-down") : dr == 0 ? (dc < 0 ? "host.pane-left" : "host.pane-right") : nullptr;
        how = dir && qAbs(dr) + qAbs(dc) == 1 ? keyFor(dir) : QString();
        if (how.isEmpty() && !keyFor("host.pane-next").isEmpty()) how = QString("%1 ×%2").arg(keyFor("host.pane-next")).arg((i - ci + n) % n);
      }
      tag(x.box, how, Qt::AlignCenter);
    }
    if (groups(*t).size() > 1) tag(t->strip, k("host.pane-next", "walks through every group"), Qt::AlignRight);
  }
}

void Host::hideBadges() {
  for (QLabel* b : badges_) b->deleteLater();
  badges_.clear();
}

// Right-click on the menu bar or the list's caption: what is shown, the menu bar included.
QMenu* Host::createPopupMenu() {
  QMenu* m = QMainWindow::createPopupMenu();
  if (!m) m = new QMenu(this);
  m->addSeparator();
  QAction* a = m->addAction("Persist menu bar");
  a->setCheckable(true);
  a->setChecked(menuPersist_);
  a->setToolTip("Off: the menu bar stays hidden; hold Alt to bring it up");
  connect(a, &QAction::toggled, this, [this](bool on) { setMenuPersist(on); });
  return m;
}

void Host::setMenuPersist(bool on) {
  menuPersist_ = on;
  menuBar()->setVisible(on);
  if (statePersisted()) QSettings("my-claude", "mc-term").setValue("menuPersist", on);
  if (!on) statusBar()->showMessage("Menu bar hidden: hold Alt to see it (right-click the list's caption to keep it)", 6000);
}

// ---- other machines in this window ----------------------------------------------------


QJsonObject Host::tagIn(const QJsonObject& m0, const QString& tag) const {
  QJsonObject m = m0;
  for (const char* k : {"id", "tab", "node", "select"}) if (m.contains(k) && m.value(k).isString()) m[k] = tagName(m.value(k).toString(), tag);
  for (const char* k : {"ids", "order"}) if (m.value(k).isArray()) { QJsonArray a; for (const auto& v : m.value(k).toArray()) a << tagName(v.toString(), tag); m[k] = a; }
  if (m.value("op").toString() == "tree") m["nodes"] = tagTree(m.value("nodes").toArray(), tag, true);
  if (m.contains("tmux")) { QJsonObject t = m.value("tmux").toObject(); t["session"] = tag + "|" + t.value("session").toString(); m["tmux"] = t; }
  return m;
}

// Which connection gets an event, and how it reads: a machine's driver hears only about
// its own projects (names untagged); this machine's driver about everything else.
bool Host::routeEvent(const QJsonObject& ev, const QString& tag, QJsonObject* out) const {
  QString owner;
  bool named = false;
  for (const char* k : {"id", "tab", "node"}) {
    const QString v = ev.value(k).toString();
    if (v.isEmpty()) continue;
    named = true;
    owner = tagOf(v);
    break;
  }
  const QString kind = ev.value("ev").toString();
  if (kind == "answer" || kind == "pane-scheme" || kind == "pane-text") { // dialogs and per-pane prefs carry ids too
    const QString v = ev.value("id").toString();
    owner = tagOf(v.contains('/') ? v : v.section('#', 0, 0));
  }
  if (tag.isEmpty()) { // this machine's driver
    if (!owner.isEmpty() && machines_.contains(owner)) return false;
    *out = ev;
    return true;
  }
  if (!named && kind != "answer") {
    // things for everyone (hello, pong, quit) yes; the user's app-wide actions are this machine's
    static const QSet<QString> mine{"action", "settings", "settings-open", "tab"};
    if (mine.contains(kind)) return false;
    *out = ev;
    return true;
  }
  if (owner != tag) return false;
  QJsonObject e = ev;
  for (const char* k : {"id", "tab", "node"}) if (e.value(k).isString() && !e.value(k).toString().isEmpty()) e[k] = untagName(e.value(k).toString(), tag);
  *out = e;
  return true;
}

QStringList Host::tmuxFor(const QString& key, QString* session) const {
  const int bar = key.indexOf('|');
  if (bar < 0) { *session = key; return tmuxCmd_; }
  *session = key.mid(bar + 1);
  const auto it = machines_.constFind(key.left(bar));
  return it == machines_.constEnd() ? tmuxCmd_ : it->tmux;
}

void Host::rebuildTree() {
  QJsonArray all = localTree_;
  for (const Machine& mc : machines_) {
    if (!mc.tree.isEmpty()) { for (const auto& v : mc.tree) all << v; continue; }
    // not connected (yet, or any more): one entry that says so
    all << QJsonObject{{"id", "m:" + mc.tag}, {"label", mc.tag}, {"dim", true}, {"dot", mc.state == "failed" ? "bang" : "empty"},
                       {"dotColor", mc.state == "failed" ? "#e5484d" : "#8d93a3"}, {"badge", mc.state == "failed" ? QString("✗") : QString("…")},
                       {"tooltip", mc.state == "failed" ? "cannot reach my-claude there (ssh, or my-claude not installed)" : "connecting…"}};
  }
  setTree(all);
}

void Host::startMachine(const QString& tag) {
  auto it = machines_.find(tag);
  if (it == machines_.end() || it->driver) return;
  auto* p = new QProcess(this);
  it->driver = p;
  it->state = "connecting";
  p->setProcessEnvironment(childEnv());
  const QString dir = QStandardPaths::writableLocation(QStandardPaths::GenericCacheLocation) + "/my-claude";
  QDir().mkpath(dir);
  p->setStandardErrorFile(dir + "/gui-driver-" + tag + ".log", QIODevice::Append);
  auto* bridge = new QLocalSocket(p);
  bridge->connectToServer(socketPath_);
  bridge->waitForConnected(2000);
  bridge->write(QJsonDocument(QJsonObject{{"op", "iam"}, {"machine", tag}}).toJson(QJsonDocument::Compact) + "\n");
  connect(p, &QProcess::readyReadStandardOutput, bridge, [p, bridge] { bridge->write(p->readAllStandardOutput()); });
  connect(bridge, &QLocalSocket::readyRead, p, [p, bridge] { p->write(bridge->readAll()); });
  connect(p, &QProcess::finished, this, [this, tag, p](int code, QProcess::ExitStatus) {
    auto m = machines_.find(tag);
    if (m == machines_.end() || m->driver != p) return;
    m->driver = nullptr;
    p->deleteLater();
    m->tree = QJsonArray();
    m->state = "failed";
    // its terminals stay: the projects run on there; they come back when it does
    rebuildTree();
    statusBar()->showMessage(QString("%1: lost (%2); trying again").arg(tag).arg(code), 8000);
    if (m->wanted) QTimer::singleShot(qMin(60000, 3000 * (1 << qMin(m->restarts++, 4))), this, [this, tag] { startMachine(tag); });
  });
  rebuildTree();
  p->start(it->driverArgv.value(0), it->driverArgv.mid(1));
}

void Host::stopMachine(const QString& tag) {
  auto it = machines_.find(tag);
  if (it == machines_.end()) return;
  it->wanted = false;
  QProcess* p = it->driver;
  QStringList ids;
  for (const Term& t : terms_) if (tagOf(t.id) == tag) ids << t.id;
  for (const QString& id : ids) closeTerm(id, false);
  machines_.erase(it);
  if (p) { p->disconnect(this); p->terminate(); if (!p->waitForFinished(1500)) p->kill(); p->deleteLater(); }
  rebuildTree();
}
