// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "planpanel.h"

#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QMouseEvent>
#include <QResizeEvent>
#include <QScrollBar>
#include <QSizeGrip>
#include <QTextBrowser>
#include <QToolButton>
#include <QVBoxLayout>

PlanPanel::PlanPanel(QWidget* parent) : QFrame(parent, Qt::SubWindow) {
  setObjectName("plan");
  setAttribute(Qt::WA_StyledBackground, true);
  setStyleSheet("QFrame#plan { background: #13151a; border: 1px solid #4a5163; } QWidget#planBar { background: #222631; }");
  auto* col = new QVBoxLayout(this);
  col->setContentsMargins(1, 1, 1, 1);
  col->setSpacing(0);
  bar_ = new QWidget(this);
  bar_->setObjectName("planBar");
  bar_->setAttribute(Qt::WA_StyledBackground, true);
  bar_->setFixedHeight(24);
  bar_->setCursor(Qt::SizeAllCursor);
  bar_->installEventFilter(this);
  auto* row = new QHBoxLayout(bar_);
  row->setContentsMargins(8, 2, 4, 2);
  title_ = new QLabel(bar_);
  title_->setAttribute(Qt::WA_TransparentForMouseEvents); // the bar takes the drag
  row->addWidget(title_, 1);
  auto* close = new QToolButton(bar_);
  close->setText("✕");
  close->setAutoRaise(true);
  close->setToolTip("Close the plan");
  connect(close, &QToolButton::clicked, this, [this] { hide(); emit closed(); });
  row->addWidget(close);
  col->addWidget(bar_);
  text_ = new QTextBrowser(this);
  text_->setOpenLinks(false); // a link in a plan must not replace the plan
  col->addWidget(text_, 1);
  ask_ = new QLineEdit(this);
  connect(ask_, &QLineEdit::returnPressed, this, [this] {
    const QString q = ask_->text().trimmed();
    if (q.isEmpty()) return;
    emit asked(text_->textCursor().selectedText().replace(QChar::ParagraphSeparator, '\n').trimmed(), q);
    ask_->clear();
  });
  col->addWidget(ask_);
  grip_ = new QSizeGrip(this);
  grip_->setFixedSize(14, 14);
}

void PlanPanel::setPlan(const QString& path, const QString& agent, const QString& markdown) {
  path_ = path;
  title_->setText("<b>" + path.toHtmlEscaped() + "</b>");
  ask_->setPlaceholderText("Ask " + agent + " about the selection (Enter)");
  const int at = text_->verticalScrollBar()->value();
  text_->setMarkdown(markdown);
  text_->verticalScrollBar()->setValue(at);
}

QString PlanPanel::plainText() const { return text_->toPlainText(); }

bool PlanPanel::select(const QString& text) {
  text_->moveCursor(QTextCursor::Start);
  const bool found = text_->find(text);
  ask_->setFocus();
  return found;
}

bool PlanPanel::eventFilter(QObject* o, QEvent* e) {
  if (o == bar_ && (e->type() == QEvent::MouseButtonPress || e->type() == QEvent::MouseMove)) {
    auto* me = static_cast<QMouseEvent*>(e);
    const QPoint at = me->globalPosition().toPoint();
    if (e->type() == QEvent::MouseButtonPress) grab_ = at - pos();
    else if ((me->buttons() & Qt::LeftButton) && parentWidget()) {
      const QRect area = parentWidget()->rect();
      move(qBound(0, (at - grab_).x(), qMax(0, area.width() - 80)), qBound(0, (at - grab_).y(), qMax(0, area.height() - bar_->height())));
    }
    return true;
  }
  return QFrame::eventFilter(o, e);
}

void PlanPanel::resizeEvent(QResizeEvent* e) {
  QFrame::resizeEvent(e);
  grip_->move(width() - grip_->width() - 1, height() - grip_->height() - 1);
}
