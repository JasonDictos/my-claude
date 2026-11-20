// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// One dark palette whatever the desktop's, and terminals faintly tinted by their project, two
// shades alternating so a glance tells the project and where a pane ends.
#pragma once
#include <QColor>
#include <QString>

class QApplication;

namespace theme {
void applyChrome(QApplication& app);
// A terminal's background for a project colour; shade 0 or 1; strength 0 (none) to 1.
QColor terminalBackground(const QColor& project, int shade, double strength);
// The colour scheme file for that background (made on first use), for QTermWidget::setColorScheme.
QString scheme(const QColor& project, int shade, double strength);
// The strip above a terminal.
QString headerStyle(const QColor& project, bool active);
QString stripButtonStyle(const QColor& project);
QString groupButtonStyle(const QColor& project, bool current);
}
