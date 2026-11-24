// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// A dialog from a JSON Schema and values, answers sent back; the window knows nothing of what
// it asks. An "object" property is a section (a tab) of its own.
#pragma once
#include <QDialog>
#include <QTreeWidget>
#include <functional>
#include <QHash>
#include <QJsonArray>
#include <QJsonObject>
#include <QList>
#include <QSet>

class QFormLayout;
class QWidget;

class QTabWidget;

// The Shortcuts table (format "keys"): action | shipped keys | the user's own | enabled. A click
// on a Custom cell takes the next key pressed (Esc clears it). A key another row has is asked
// about, and that row turned off; a key the desktop holds (KDE) is refused.
class KeyTable : public QTreeWidget {
  Q_OBJECT
public:
  KeyTable(const QJsonObject& p, const QJsonArray& values, QWidget* parent = nullptr);
  QJsonArray value() const;
  // tests: a key pressed into a row's Custom cell, as a click then a press would
  void capture(const QString& id, int key, Qt::KeyboardModifiers mods);
  void setEnabledRow(const QString& id, bool on);

protected:
  bool event(QEvent* e) override;
  void keyPressEvent(QKeyEvent* e) override;
  void focusOutEvent(QFocusEvent* e) override;

private:
  enum Col { Action, Stock, Custom, On };
  QTreeWidgetItem* row(const QString& id) const;
  QList<int> keysOf(QTreeWidgetItem* it) const; // what the row binds now
  QTreeWidgetItem* holder(int key, QTreeWidgetItem* except) const;
  void startCapture(QTreeWidgetItem* it);
  void endCapture(); // the cell shows its key again
  void offer(QTreeWidgetItem* it, const QString& key); // a key pressed for a row: checked, then set
  void setCustom(QTreeWidgetItem* it, const QString& key);
  void toggled(QTreeWidgetItem* it);
  void paintRow(QTreeWidgetItem* it);
  void askDesktop(const QList<int>& keys, std::function<void()> then);
  void tell(const QString& title, const QString& text);
  void confirm(const QString& title, const QString& text, const QString& ok, std::function<void(bool)> answer);
  QTreeWidgetItem* capturing_ = nullptr;
  QString before_;
  bool system_ = false;
  QHash<int, QString> desktop_; // key -> what holds it on the desktop
  QSet<int> asked_;
  int pending_ = 0;                        // questions to the desktop not answered yet
  QList<std::function<void()>> waiting_;   // what waits for those answers
};

class FormDialog : public QDialog {
  Q_OBJECT
public:
  // spec: {title, text, schema, values, ok, cancel}
  FormDialog(const QJsonObject& spec, QWidget* parent = nullptr);
  QJsonObject values() const;
  void setChoices(const QString& key, const QJsonArray& choices, const QJsonArray& labels, const QString& note, const QJsonArray& rows = {});
  void refilter(const QString& key);
  // Tests answer a dialog without driving its widgets.
  void answer(const QJsonObject& v) { answer_ = v; answered_ = true; accept(); }

protected:
  void accept() override;

private:
  struct Field { QString key, group, type; bool required = false; QWidget* widget = nullptr; QWidget* focus = nullptr; }; // focus: where the keyboard starts, when not widget
  void addFields(QFormLayout* form, const QJsonObject& schema, const QJsonObject& values, const QString& group);
  QJsonValue read(const Field& f) const;
  static void setupTable(class QTreeWidget* tw, const QJsonObject& p);
  static QJsonArray rowsOf(const QJsonObject& p);
  static void fillTable(class QTreeWidget* tw, const QJsonArray& choices, const QJsonArray& rows, const QString& cur, const QSet<QString>* ticked);
  QList<Field> fields_;
  QHash<QString, class QComboBox*> filters_; // list field -> the dropdown that filters it
  QJsonObject answer_;
  bool answered_ = false;
  QTabWidget* tabs_ = nullptr;
};
