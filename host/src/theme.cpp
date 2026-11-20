// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "theme.h"
#include <QApplication>
#include <QDir>
#include <QFile>
#include <QPalette>
#include <QSet>
#include <QStandardPaths>
#include <QStyleFactory>
#include <QTextStream>

namespace {
// surfaces, back to front
const char* const kBase = "#0d0f13";   // a terminal with no project colour
const char* const kWindow = "#13151a";
const char* const kPanel = "#181b21";  // sidebar, bars
const char* const kRaised = "#222631"; // hover, buttons
const char* const kLine = "#2a2e39";
const char* const kText = "#d4d8e1";
const char* const kDim = "#8d93a3";
const char* const kFaint = "#5c6272";
const char* const kAccent = "#6ea8fe";
const char* const kSelected = "#27344d";

QColor mix(const QColor& a, const QColor& b, double t) { // t of a, the rest b
  return QColor::fromRgbF(a.redF() * t + b.redF() * (1 - t), a.greenF() * t + b.greenF() * (1 - t), a.blueF() * t + b.blueF() * (1 - t));
}

// The 16 colours programs name, normal and bright; the same in every project.
struct Ansi { const char* normal; const char* bright; };
const Ansi kAnsi[8] = {
  {"#1c2029", "#636a7b"}, // black
  {"#e5727a", "#ff8f96"}, // red
  {"#9ccf7c", "#b8ea97"}, // green
  {"#e6c27a", "#ffdb94"}, // yellow
  {"#6cb0f2", "#8cc7ff"}, // blue
  {"#c98ae0", "#e2a6f5"}, // magenta
  {"#5cc1cc", "#84dde7"}, // cyan
  {"#c6cbd4", "#ffffff"}, // white
};
}

void theme::applyChrome(QApplication& app) {
  // Fusion draws everything itself, so the palette below is what shows, on any desktop.
  if (QStyle* fusion = QStyleFactory::create("Fusion")) app.setStyle(fusion);
  QPalette p;
  p.setColor(QPalette::Window, kWindow);
  p.setColor(QPalette::WindowText, kText);
  p.setColor(QPalette::Base, kPanel);
  p.setColor(QPalette::AlternateBase, kWindow);
  p.setColor(QPalette::Text, kText);
  p.setColor(QPalette::Button, kRaised);
  p.setColor(QPalette::ButtonText, kText);
  p.setColor(QPalette::BrightText, "#ffffff");
  p.setColor(QPalette::ToolTipBase, kRaised);
  p.setColor(QPalette::ToolTipText, kText);
  p.setColor(QPalette::Highlight, kSelected);
  p.setColor(QPalette::HighlightedText, "#ffffff");
  p.setColor(QPalette::Link, kAccent);
  p.setColor(QPalette::PlaceholderText, kFaint);
  p.setColor(QPalette::Light, kRaised);
  p.setColor(QPalette::Midlight, kLine);
  p.setColor(QPalette::Mid, kLine);
  p.setColor(QPalette::Dark, kBase);
  p.setColor(QPalette::Shadow, "#000000");
  for (const QPalette::ColorRole r : {QPalette::WindowText, QPalette::Text, QPalette::ButtonText}) p.setColor(QPalette::Disabled, r, kFaint);
  app.setPalette(p);
  QString css = R"(
QDialog { background: @window; }
QWidget#strip { background: @panel; border-top: 1px solid @line; }
QMenuBar { background: @panel; color: #b9bfcc; border-bottom: 1px solid @line; padding: 1px 4px; }
QMenuBar::item { padding: 4px 10px; background: transparent; border-radius: 4px; }
QMenuBar::item:selected, QMenuBar::item:pressed { background: @raised; color: @text; }
QMenu { background: @panel; color: @text; border: 1px solid @line; padding: 4px; }
QMenu::item { padding: 5px 24px 5px 14px; border-radius: 4px; }
QMenu::item:selected { background: @selected; }
QMenu::item:disabled { color: @faint; }
QMenu::separator { height: 1px; background: @line; margin: 4px 8px; }
QTabWidget::pane { border: 0; }
QTabBar { background: @panel; }
QTabBar::tab { background: transparent; color: @dim; padding: 6px 10px 5px 12px; border: 0; border-bottom: 2px solid transparent; }
QTabBar::tab:hover { background: #1e222a; color: @text; }
QTabBar::tab:selected { background: @window; color: #ffffff; border-bottom: 2px solid @accent; }
QTabBar::close-button { image: url(:/close.svg); subcontrol-position: right; margin: 2px 2px 2px 6px; }
QTabBar::close-button:hover { image: url(:/close-hover.svg); }
QMainWindow::separator { background: @line; width: 1px; height: 1px; }
QLabel#docktitle { background: @panel; color: @faint; padding: 7px 10px 5px 10px; border-bottom: 1px solid @line; font-size: 11px; letter-spacing: 1px; }
QSizeGrip { image: none; width: 0; height: 0; }
QDockWidget { color: @dim; }
QDockWidget::title { background: @panel; padding: 6px 8px; border-bottom: 1px solid @line; }
QTreeWidget { background: @panel; color: #c9ced9; border: 0; outline: 0; }
QTreeWidget::item { height: 26px; }
QTreeWidget::item:hover { background: #1f232c; }
QTreeWidget::item:selected { background: @selected; color: #ffffff; }
QStatusBar { background: @panel; color: @dim; border-top: 1px solid @line; }
QStatusBar::item { border: 0; }
QStatusBar QLabel { color: @dim; padding: 0 6px; }
QSplitter::handle { background: @line; }
QScrollBar:vertical { background: transparent; width: 10px; margin: 0; }
QScrollBar::handle:vertical { background: #343a49; min-height: 28px; border-radius: 3px; margin: 2px 2px 2px 3px; }
QScrollBar::handle:vertical:hover { background: #4a5266; }
QScrollBar:horizontal { background: transparent; height: 10px; margin: 0; }
QScrollBar::handle:horizontal { background: #343a49; min-width: 28px; border-radius: 3px; margin: 3px 2px 2px 2px; }
QScrollBar::handle:horizontal:hover { background: #4a5266; }
QScrollBar::add-line, QScrollBar::sub-line { width: 0; height: 0; }
QScrollBar::add-page, QScrollBar::sub-page { background: transparent; }
QToolTip { background: @raised; color: @text; border: 1px solid @line; padding: 4px 6px; }
QLineEdit, QPlainTextEdit, QTextEdit, QSpinBox, QComboBox { background: #0f1116; color: @text; border: 1px solid @line; border-radius: 4px; padding: 4px 6px; selection-background-color: @selected; }
QLineEdit:focus, QPlainTextEdit:focus, QTextEdit:focus, QSpinBox:focus, QComboBox:focus { border-color: @accent; }
QComboBox QAbstractItemView { background: @panel; color: @text; border: 1px solid @line; selection-background-color: @selected; }
QPushButton { background: @raised; color: @text; border: 1px solid #2f3442; border-radius: 4px; padding: 5px 14px; }
QPushButton:hover { background: #2a2f3c; }
QPushButton:default { border-color: @accent; }
QPushButton:disabled { color: @faint; }
QGroupBox { border: 1px solid @line; border-radius: 6px; margin-top: 12px; padding-top: 10px; }
QGroupBox::title { subcontrol-origin: margin; left: 10px; color: @dim; }
QLabel#placeholder { color: @faint; background: @window; }
)";
  const QList<QPair<QString, QString>> names = {{"@window", kWindow}, {"@panel", kPanel}, {"@raised", kRaised}, {"@line", kLine}, {"@text", kText}, {"@dim", kDim}, {"@faint", kFaint}, {"@accent", kAccent}, {"@selected", kSelected}};
  for (const auto& n : names) css.replace(n.first, n.second);
  app.setStyleSheet(css);
}

QColor theme::terminalBackground(const QColor& project, int shade, double strength) {
  float h = 0, s = 0, l = 0;
  if (project.isValid()) project.getHslF(&h, &s, &l);
  const bool grey = !project.isValid() || s < 0.08 || h < 0 || strength <= 0;
  if (grey) return QColor(shade ? "#14171d" : kBase);
  return QColor::fromHslF(h, qBound(0.0, double(s) * strength, 0.6), shade ? 0.098 : 0.066);
}

QString theme::scheme(const QColor& project, int shade, double strength) {
  const QColor bg = terminalBackground(project, shade, strength);
  const QString name = "mc-" + bg.name().mid(1);
  const QString dir = QStandardPaths::writableLocation(QStandardPaths::GenericCacheLocation) + "/my-claude/schemes";
  const QString path = dir + "/" + name + ".colorscheme";
  static QSet<QString> written;
  if (written.contains(name)) return path;
  QDir().mkpath(dir);
  QFile f(path);
  if (!f.open(QIODevice::WriteOnly | QIODevice::Truncate)) return QString();
  QTextStream o(&f);
  const auto entry = [&](const QString& key, const QColor& c) { o << "[" << key << "]\nBold=false\nColor=" << c.red() << "," << c.green() << "," << c.blue() << "\n\n"; };
  entry("Background", bg);
  entry("BackgroundIntense", bg.lighter(135));
  for (int i = 0; i < 8; ++i) {
    entry(QString("Color%1").arg(i), QColor(kAnsi[i].normal));
    entry(QString("Color%1Intense").arg(i), QColor(kAnsi[i].bright));
  }
  entry("Foreground", QColor(kText));
  entry("ForegroundIntense", QColor("#ffffff"));
  o << "[General]\nDescription=my-claude " << bg.name() << "\nOpacity=1\n";
  f.close();
  written.insert(name);
  return path;
}

QString theme::headerStyle(const QColor& project, bool active) {
  const QColor c = project.isValid() ? project : QColor(kDim);
  const QColor bg = mix(c, QColor(kPanel), active ? 0.62 : 0.20);
  const QColor edge = active ? c : mix(c, QColor(kPanel), 0.35);
  return QString("QLabel { background: %1; color: %2; border-bottom: 1px solid %3; padding-left: 2px; }").arg(bg.name(), active ? "#ffffff" : "#aab0be", edge.name());
}

QString theme::stripButtonStyle(const QColor& project) {
  const QColor c = project.isValid() ? project : QColor(kDim);
  return QString("QToolButton { color: %1; background: %2; border: 1px solid %3; border-radius: 4px; padding: 2px 10px; } QToolButton:hover { background: %4; }")
    .arg(mix(c, QColor("#ffffff"), 0.6).name(), mix(c, QColor(kPanel), 0.18).name(), mix(c, QColor(kPanel), 0.45).name(), mix(c, QColor(kPanel), 0.30).name());
}

QString theme::groupButtonStyle(const QColor& project, bool current) {
  const QColor c = project.isValid() ? project : QColor(kDim);
  if (current) return QString("QToolButton { color: #ffffff; background: %1; border: 0; border-bottom: 2px solid %2; padding: 3px 12px; }").arg(mix(c, QColor(kPanel), 0.30).name(), c.name());
  return QString("QToolButton { color: %1; background: transparent; border: 0; border-bottom: 2px solid transparent; padding: 3px 12px; } QToolButton:hover { background: %2; color: %3; }").arg(kDim, kRaised, kText);
}
