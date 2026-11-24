// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "colorscrub.h"

#include <QMouseEvent>
#include <QPainter>
#include <QWheelEvent>
#include <algorithm>
#include <cmath>

ColorScrub::ColorScrub(const QColor& c, QWidget* parent) : QWidget(parent), color_(c) {
  setFixedSize(22, 22);
  setCursor(Qt::SizeAllCursor);
  setToolTip(c.name() + ": click to take it, or hold and move: left/right the hue, up/down lighter or darker, the wheel how vivid");
}

void ColorScrub::paintEvent(QPaintEvent*) {
  QPainter p(this);
  p.fillRect(rect().adjusted(1, 1, -1, -1), color_);
  p.setPen(QColor("#4a5163"));
  p.drawRect(rect().adjusted(0, 0, -1, -1));
}

void ColorScrub::mousePressEvent(QMouseEvent* e) {
  if (e->button() != Qt::LeftButton) return;
  held_ = true;
  from_ = at_ = e->position().toPoint();
  ds_ = 0;
  color_.getHslF(&h_, &s_, &l_);
  h_ = std::max(h_, 0.0f); // a grey has no hue: start from red's
  grabMouse(); // the drag keeps coming here once it leaves the swatch
  emit scrubbed(color_);
}

void ColorScrub::mouseMoveEvent(QMouseEvent* e) {
  if (!held_) return;
  at_ = e->position().toPoint();
  follow();
}

void ColorScrub::wheelEvent(QWheelEvent* e) {
  if (!held_) return;
  ds_ += e->angleDelta().y() / 120.0f * 0.05f;
  follow();
  e->accept();
}

void ColorScrub::mouseReleaseEvent(QMouseEvent* e) {
  if (e->button() != Qt::LeftButton || !held_) return;
  held_ = false;
  releaseMouse();
}

// A pixel right is a degree of hue; a pixel up is a little lighter.
void ColorScrub::follow() {
  const QPoint d = at_ - from_;
  float h = h_ + d.x() / 360.0f;
  h -= std::floor(h);
  const float l = std::clamp(l_ - d.y() * 0.004f, 0.05f, 0.95f);
  const float s = std::clamp(s_ + ds_, 0.0f, 1.0f);
  emit scrubbed(QColor::fromHslF(h, s, l));
}
