// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// An icon stacked from SVG files, each in its own box of a 24x24 canvas (a state frame, then a
// provider badge over its corner): drawn at the size asked for, so it stays sharp on any screen.
#pragma once
#include <QIcon>
#include <QList>
#include <QPair>
#include <QRectF>
#include <QString>

QIcon layeredIcon(const QList<QPair<QString, QRectF>>& layers);
