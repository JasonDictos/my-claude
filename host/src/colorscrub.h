// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#pragma once

#include <QColor>
#include <QPoint>
#include <QWidget>

// A colour swatch the mouse scrubs, instead of a picker window: held down and moved, left/right
// turns the hue round the wheel, up/down goes through that colour's spectrum (lighter up), and
// the wheel its saturation; the colour follows live. A click without moving takes the swatch's.
class ColorScrub : public QWidget {
  Q_OBJECT
public:
  ColorScrub(const QColor& c, QWidget* parent);

signals:
  void scrubbed(const QColor& c);

protected:
  void paintEvent(QPaintEvent* e) override;
  void mousePressEvent(QMouseEvent* e) override;
  void mouseMoveEvent(QMouseEvent* e) override;
  void mouseReleaseEvent(QMouseEvent* e) override;
  void wheelEvent(QWheelEvent* e) override;

private:
  void follow();
  QColor color_;
  bool held_ = false;
  QPoint from_, at_;
  float h_ = 0, s_ = 0, l_ = 0; // where the scrub started
  float ds_ = 0;                // the saturation the wheel added
};
