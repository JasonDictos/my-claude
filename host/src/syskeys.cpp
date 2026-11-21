// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "syskeys.h"
#include <QCoreApplication>
#include <QDBusConnection>
#include <QDBusInterface>
#include <QDBusReply>
#include <QKeySequence>
#include <QPointer>
#include <QThread>

void systemKeyOwners(const QList<int>& keys, QObject* ctx, std::function<void(QHash<int, QString>)> done) {
  QPointer<QObject> guard(ctx);
  // tests have no desktop: MC_TERM_TEST_DESKTOP_KEYS says what it holds ("Alt+F1=Plasma › Launcher;…")
  if (qEnvironmentVariableIsSet("MC_TERM_TEST") || qEnvironmentVariable("QT_QPA_PLATFORM") == "offscreen") {
    QHash<int, QString> owners;
    for (const QString& pair : qEnvironmentVariable("MC_TERM_TEST_DESKTOP_KEYS").split(';', Qt::SkipEmptyParts)) {
      const int k = QKeySequence(pair.section('=', 0, 0))[0].toCombined();
      if (keys.contains(k)) owners.insert(k, pair.section('=', 1));
    }
    QMetaObject::invokeMethod(qApp, [guard, done, owners] { if (guard) done(owners); }, Qt::QueuedConnection);
    return;
  }
  QThread* worker = QThread::create([keys, guard, done] {
    QHash<int, QString> owners;
    QDBusConnection bus = QDBusConnection::sessionBus();
    if (bus.isConnected()) {
      QDBusInterface accel("org.kde.kglobalaccel", "/kglobalaccel", "org.kde.KGlobalAccel", bus);
      if (accel.isValid()) {
        for (int k : keys) {
          if (!k || owners.contains(k)) continue;
          // [component, action, component's name, action's name]
          const QDBusReply<QStringList> r = accel.call("action", k);
          const QStringList who = r.isValid() ? r.value() : QStringList();
          if (who.size() < 4 || who[0].startsWith("mc-term")) continue;
          owners.insert(k, who[2] + " › " + who[3]);
        }
      }
    }
    QMetaObject::invokeMethod(qApp, [guard, done, owners] { if (guard) done(owners); }, Qt::QueuedConnection);
  });
  QObject::connect(worker, &QThread::finished, worker, &QObject::deleteLater);
  worker->start();
}
