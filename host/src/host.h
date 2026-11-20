// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// mc-term, my-claude's window, deliberately dumb: drawn from what a driver sends (PROTOCOL.md),
// everything reported back as events; the driver holds the logic.
#pragma once
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QLabel>
#include <QList>
#include <QMainWindow>
#include <QElapsedTimer>
#include <QProcessEnvironment>
#include <QSet>
#include <QSharedPointer>
#include <QUrl>
#include <functional>

class Dialect;
class Feed;
class FormDialog;
class TmuxControl;
class QAction;
class QDockWidget;
class QFrame;
class QHBoxLayout;
class QLocalServer;
class QLocalSocket;
class QProcess;
class QSplitter;
class QStackedWidget;
class QTabWidget;
class QTermWidget;
class QTimer;
class QTreeWidget;
class QTreeWidgetItem;

// QTermWidget's signals by name: pointer-to-member connects across that library fail silently
// (the signal's address differs across the boundary).
class TermHook : public QObject {
  Q_OBJECT
public:
  using QObject::QObject;
  std::function<void()> finished, focused, bell, title;
  std::function<void(const QByteArray&)> send; // what the emulator made of the user's keys
  std::function<void(bool)> selected;
public slots:
  void onFinished() { if (finished) finished(); }
  void onFocused() { if (focused) focused(); }
  void onBell(const QString&) { if (bell) bell(); }
  void onTitle() { if (title) title(); }
  void onUrl(const QUrl& url, bool);
  void onSend(const char* data, int n) { if (send) send(QByteArray(data, n)); }
  void onCopyAvailable(bool yes) { if (selected) selected(yes); }
};

// The strip above a terminal: its name, and the place to click, double-click (zoom) or
// right-click (the pane's menu) without the click going to the program inside.
class Header : public QLabel {
  Q_OBJECT
public:
  using QLabel::QLabel;
signals:
  void pressed();
  void doubleClicked();
  void menuRequested(const QPoint& globalPos);
protected:
  void mousePressEvent(QMouseEvent* e) override;
  void mouseDoubleClickEvent(QMouseEvent* e) override;
  void contextMenuEvent(QContextMenuEvent* e) override;
};

struct Term {
  QString id, tab, title, color, attention, node;
  bool minimised = false;
  QTermWidget* widget = nullptr;
  QTimer* redrawTimer = nullptr; // after a show or a resize: fetch the picture again
  int shade = 0;                 // which of its project's two background shades
  QString schemeKey;             // the colours it has now
  QString ownScheme;             // chosen for this pane alone; empty: the window's
  int textStep = 0;              // this pane's text size, in points over the window's
  QFrame* box = nullptr; // header + terminal
  Header* header = nullptr;
  // A tmux pane shown natively (see tmuxctl.h): fed its raw output, not running a process.
  bool native = false;
  QString session, pane, window;
  Feed* feed = nullptr;
  QSharedPointer<Dialect> dialect; // what the program wrote for tmux, made fit for the widget
  QTimer* resizeTimer = nullptr;
  QTimer* reflowTimer = nullptr;   // after a resize: does the widget still show what tmux holds?
  QTimer* thawTimer = nullptr;     // painting held back while a pane's state is poured in
  bool seeded = false; // asked tmux for the pane's state at least once
  bool live = false;   // the state is in: output applies from here on
  bool off = false;    // behind: tmux's output stays unread until this terminal catches up
  int cols = 0, rows = 0;
  bool resizePending = false; // the widget was resized since its size was last looked at
  qint64 lastOutput = 0, resizedAt = 0; // on the window's clock
  int resizeGen = 0, seededGen = -1;    // one re-read of the pane per resize, at most
  int histSkew = 0;                     // widget scrollback lines minus tmux's, when last in step
  bool skewKnown = false;
};

struct Tab {
  QString name, color, zoomed, lastFocus;
  int group = 0; // which group of panes is on screen, when there are more than fit
  QWidget* page = nullptr;
  QSplitter* rows = nullptr;
  QWidget* strip = nullptr; // minimised panes, as buttons
  QHBoxLayout* stripLay = nullptr;
  QStringList order; // terminal ids, grid order
};

class Host : public QMainWindow {
  Q_OBJECT
public:
  Host(const QString& socketPath, const QString& driverCmd, QWidget* parent = nullptr);
  ~Host() override;
  bool restoredGeometry() const { return restored_; }
  // Another machine's projects: the driver and tmux run there, reached with these
  // commands (ssh). "{rsock}" in the driver's is a socket path there, new for each start.
  void setRemote(const QString& name, const QStringList& driverArgv, const QStringList& tmux);

protected:
  void closeEvent(QCloseEvent* e) override;
  bool eventFilter(QObject* o, QEvent* e) override;

private:
  // --- socket
  QString socketPath_;
  QLocalServer* server_ = nullptr;
  QSet<QLocalSocket*> clients_;
  QHash<QLocalSocket*, QByteArray> buffers_;
  void onConnection();
  void onReadyRead(QLocalSocket* s);
  void handle(const QJsonObject& msg, QLocalSocket* from);
  void emitEvent(const QJsonObject& ev);
  void reply(QLocalSocket* to, const QJsonObject& msg);

  // --- driver (the my-claude process that tells this window what to show)
  QString driverCmd_;
  QStringList driverArgv_;          // set: run this instead of driverCmd_ (a remote driver)
  QStringList tmuxCmd_ = {"tmux"};  // how tmux is run
  QString remote_;                  // the other machine's name, for the title
  QProcess* driver_ = nullptr;
  QLocalSocket* driverSock_ = nullptr; // the client that said it is the driver
  // Other machines in this same window: each has a driver of its own (over ssh), its
  // tabs and tree entries tagged "<project>@<machine>", its panes reached by its tmux.
  struct Machine { QString tag; QStringList driverArgv, tmux; QProcess* driver = nullptr; QJsonArray tree; QString state; int restarts = 0; bool wanted = true; };
  QMap<QString, Machine> machines_;
  QHash<QLocalSocket*, QString> clientTag_; // a machine's driver connection -> its tag
  QJsonArray localTree_;
  void startMachine(const QString& tag);
  void stopMachine(const QString& tag);
  void rebuildTree();
  QJsonObject tagIn(const QJsonObject& m, const QString& tag) const;
  bool routeEvent(const QJsonObject& ev, const QString& tag, QJsonObject* out) const;
  QStringList tmuxFor(const QString& sessionKey, QString* session) const;
  QList<QJsonObject> held_; // what the user did while no driver was listening
  QList<qint64> driverStarts_;
  bool quitting_ = false;
  bool restored_ = false;
  QLabel* driverLabel_ = nullptr;
  QLabel* busyLabel_ = nullptr;
  void startDriver();
  void driverExited();

  // --- terminals and tabs
  QStackedWidget* center_ = nullptr;
  QLabel* placeholder_ = nullptr;
  QTabWidget* tabs_ = nullptr;
  QHash<QString, Term> terms_;
  QHash<QString, Tab> tabsByName_;
  QString activeId_;
  QString font_; // empty: the system fixed font
  int fontSize_ = 11;
  int baseFontSize_ = 11;
  QString scheme_;          // a named colour scheme; empty: ours, tinted per project
  double tint_ = 0.35;      // how much of a project's colour its terminals' background takes
  bool alternate_ = true;   // neighbouring panes in two shades
  double transparency_ = 0; // how see-through a terminal's background is (0: solid)
  bool blur_ = true;        // ask the compositor to blur what shows through
  void applyTransparency();
  void registerGlobalKey();
  QString toggleKey_;
  void showInFront();
  // the shortcut bar: hold Alt (or F1) for the keys of what has the focus
  QLabel* keyBar_ = nullptr;
  QTimer* altTimer_ = nullptr;
  QTimer* keyBarTimer_ = nullptr;
  void showKeyBar();
  QTimer* f1Hold_ = nullptr;
  bool f1Held_ = false;
  QList<QLabel*> badges_;
  void showBadges();
  QString keyFor(const QString& action) const;
  void hideBadges();
  void hideKeyBar();
  void placeKeyBar();
  bool menuPersist_ = true;
  QTimer* menuHide_ = nullptr;
  void setMenuPersist(bool on);
protected:
  void resizeEvent(QResizeEvent* e) override;
  QMenu* createPopupMenu() override;
private:
  void revealFirst();
  bool revealed_ = false;
public:
  bool startHidden_ = false;
private:
public slots:
  void revealFirstSlot() { revealFirst(); }
  void onGlobalShortcut(const QString& component, const QString& shortcut, qlonglong timestamp);
private:
  void applyTheme(Term& t);

  Tab* tabOf(const QString& name);
  Tab& tabFor(const QString& name);
  Tab* currentTab();
  QString tabName(int index) const;
  void open(const QJsonObject& m);
  void closeTerm(const QString& id, bool report);
  void closeTab(const QString& name);
  void retile(Tab& t);
  QStringList visible(const Tab& t) const;
  int perGroup_ = 4; // panes on screen at once; the rest are a key away
  QList<QStringList> groups(const Tab& t) const;
  void showGroup(Tab& t, int group);
  void reveal(const QString& id);
  void paintHeader(Term& t);
  void paintTab(const Tab& t);
  void setActive(const QString& id);
  void focusTerm(const QString& id);
  void focusCurrent();
  QString currentTermId();
  void toggleZoom(const QString& id);
  void setMinimised(const QString& id, bool on);
  void cycleTab(int step);
  void cyclePane(int step);
  void movePane(int dx, int dy);
  QFont termFont(bool* boldFits = nullptr) const;
  void applyFont();
  void updateCenter();

  // --- tmux panes shown natively
  QHash<QString, TmuxControl*> controls_; // by tmux session
  QHash<QString, QString> paneIds_;       // "<session> <pane>" -> terminal id
  QHash<QString, QList<qint64>> controlLost_; // when each session's control client was lost
  QElapsedTimer clock_;
  bool clipboardFromPrograms_ = true;     // a program in a pane may copy text (OSC 52)
  QString origTmpDir_;                    // what TMPDIR was before scrollback moved it
  bool hadTmpDir_ = false;
  int scrollback_ = -1;                   // lines; -1: unlimited, on disk
  int seedLines_ = 50000;                 // how much of tmux's scrollback a pane starts with
  bool copyOnSelect_ = true;
  bool dropdown_ = false; // Guake style: full screen, hidden on focus loss, summoned by the key
  void showAsSet();
  qint64 scrollbackCap_ = 20LL << 30;     // bytes on disk before the largest history is dropped
  QProcessEnvironment childEnv() const;
  TmuxControl* controlFor(const QString& session);
  void controlGone(const QString& session, const QString& reason);
  void startNative(const QString& id);
  void seed(const QString& id, bool keep);
  void applySeed(const QString& id, const QByteArray& facts, const QList<QByteArray>& history, const QList<QByteArray>& screen, const QList<QByteArray>& saved, bool keep);
  void syncSize(const QString& id, bool resized);
  void reflowCheck(const QString& id);
  void judgeReflow(const QString& id, const QByteArray& facts, const QList<QByteArray>& theirs, bool quiet);
  QStringList screenRows(const Term& t, int first, int last) const;
  bool cursorOf(const Term& t, int* row, int* col) const;
  void thaw(const QString& id);
  void redraw(const QString& id);
  void setTextStep(Term& t, int step, bool report);
  void resume(const QString& id);
  void guardScrollback();

  // --- sidebar
  QDockWidget* dock_ = nullptr;
  QTreeWidget* tree_ = nullptr;
  QHash<QString, QJsonArray> nodeActions_;
  QHash<QString, QTreeWidgetItem*> nodeItems_;
  QSet<QString> collapsed_;
  void setTree(const QJsonArray& nodes);
  QString currentNode() const;
  void selectNode(const QString& id);
  void showNodeMenu(const QString& node, const QPoint& globalPos, const QString& termId);
  void sidebarFocus();

  // --- menus, actions, dialogs
  QList<QAction*> actions_;
  QHash<QString, QString> sidebarKeys_; // single key -> action, while the sidebar has focus
  QJsonArray menus_;
  void setMenus(const QJsonArray& menus);
  void runAction(const QString& id);
  void local(const QString& id);
  QHash<QString, FormDialog*> asks_;
  void ask(const QJsonObject& m);
  QJsonObject settingsSchema_, settingsValues_;
  void openSettings();
};
