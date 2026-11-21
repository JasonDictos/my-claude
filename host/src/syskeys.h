// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// Keys the desktop keeps for itself (KDE's global shortcuts): pressed, they never reach a window.
#pragma once
#include <QHash>
#include <QList>
#include <QObject>
#include <QString>
#include <functional>

// Who holds each key ("Component › Action"); keys nobody holds, and my-claude's own, are left
// out. Asked on a thread of its own; `done` runs on the GUI thread unless `ctx` is gone.
// Without KDE nobody holds anything.
void systemKeyOwners(const QList<int>& keys, QObject* ctx, std::function<void(QHash<int, QString>)> done);
