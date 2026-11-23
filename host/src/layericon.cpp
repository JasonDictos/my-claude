// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "layericon.h"
#include <QIconEngine>
#include <QPainter>
#include <QPixmap>
#include <QSharedPointer>
#include <QSvgRenderer>

namespace {
class LayerEngine : public QIconEngine {
public:
  explicit LayerEngine(QList<QPair<QSharedPointer<QSvgRenderer>, QRectF>> layers) : layers_(std::move(layers)) {}
  void paint(QPainter* p, const QRect& rect, QIcon::Mode, QIcon::State) override {
    const qreal k = qMin(rect.width(), rect.height()) / 24.0;
    const QPointF at = rect.topLeft() + QPointF((rect.width() - 24 * k) / 2, (rect.height() - 24 * k) / 2);
    for (const auto& [svg, box] : layers_)
      svg->render(p, QRectF(at.x() + box.x() * k, at.y() + box.y() * k, box.width() * k, box.height() * k));
  }
  QPixmap pixmap(const QSize& size, QIcon::Mode mode, QIcon::State state) override {
    QPixmap pm(size);
    pm.fill(Qt::transparent);
    QPainter p(&pm);
    p.setRenderHint(QPainter::Antialiasing);
    paint(&p, QRect(QPoint(), size), mode, state);
    return pm;
  }
  QIconEngine* clone() const override { return new LayerEngine(layers_); }

private:
  QList<QPair<QSharedPointer<QSvgRenderer>, QRectF>> layers_;
};
} // namespace

QIcon layeredIcon(const QList<QPair<QString, QRectF>>& layers) {
  QList<QPair<QSharedPointer<QSvgRenderer>, QRectF>> drawn;
  for (const auto& [file, box] : layers) {
    auto svg = QSharedPointer<QSvgRenderer>::create(file);
    if (svg->isValid()) drawn.append({svg, box});
  }
  return drawn.isEmpty() ? QIcon() : QIcon(new LayerEngine(std::move(drawn)));
}
