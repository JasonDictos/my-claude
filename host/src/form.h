// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
// A dialog from a JSON Schema and values, answers sent back; the window knows nothing of what
// it asks. An "object" property is a section (a tab) of its own.
#pragma once
#include <QDialog>
#include <QHash>
#include <QJsonObject>
#include <QList>

class QFormLayout;
class QWidget;

class QTabWidget;
class FormDialog : public QDialog {
  Q_OBJECT
public:
  // spec: {title, text, schema, values, ok, cancel}
  FormDialog(const QJsonObject& spec, QWidget* parent = nullptr);
  QJsonObject values() const;
  void setChoices(const QString& key, const QJsonArray& choices, const QJsonArray& labels, const QString& note);
  void refilter(const QString& key);
  // Tests answer a dialog without driving its widgets.
  void answer(const QJsonObject& v) { answer_ = v; answered_ = true; accept(); }

protected:
  void accept() override;

private:
  struct Field { QString key, group, type; bool required = false; QWidget* widget = nullptr; };
  void addFields(QFormLayout* form, const QJsonObject& schema, const QJsonObject& values, const QString& group);
  QJsonValue read(const Field& f) const;
  QList<Field> fields_;
  QHash<QString, class QComboBox*> filters_; // list field -> the dropdown that filters it
  QJsonObject answer_;
  bool answered_ = false;
  QTabWidget* tabs_ = nullptr;
};
