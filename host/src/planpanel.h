// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#pragma once

#include <QFrame>
#include <QPoint>

class QLabel;
class QLineEdit;
class QTextBrowser;
class QSizeGrip;

// A plan an agent asked the user to read, floating over the agent's tab: the Markdown rendered,
// and a box to ask the agent about the passage selected in it.
class PlanPanel : public QFrame {
  Q_OBJECT
public:
  explicit PlanPanel(QWidget* parent);
  // shown or reloaded; a reload keeps where the user had scrolled to
  void setPlan(const QString& path, const QString& agent, const QString& markdown);
  QString path() const { return path_; }
  QString plainText() const;
  // tests: the passage selected as a drag would, then the keyboard in the ask box
  bool select(const QString& text);
  QString tab; // the project tab it floats over

signals:
  void asked(const QString& selection, const QString& question);
  void closed();

protected:
  bool eventFilter(QObject* o, QEvent* e) override; // dragged by its title
  void resizeEvent(QResizeEvent* e) override;

private:
  QWidget* bar_ = nullptr;
  QLabel* title_ = nullptr;
  QTextBrowser* text_ = nullptr;
  QLineEdit* ask_ = nullptr;
  QSizeGrip* grip_ = nullptr;
  QString path_;
  QPoint grab_;
};
