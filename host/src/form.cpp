// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "form.h"
#include <QCheckBox>
#include <QComboBox>
#include <QDialogButtonBox>
#include <QDoubleSpinBox>
#include <QFileDialog>
#include <QFormLayout>
#include <QGroupBox>
#include <QScrollArea>
#include <QTabWidget>
#include <QHBoxLayout>
#include <QJsonArray>
#include <QLabel>
#include <QLineEdit>
#include <QListWidget>
#include <QSet>
#include <QSignalBlocker>
#include <QPlainTextEdit>
#include <QPushButton>
#include <QSpinBox>
#include <QHeaderView>
#include <QTreeWidget>
#include <QVBoxLayout>

FormDialog::FormDialog(const QJsonObject& spec, QWidget* parent) : QDialog(parent) {
  const QJsonObject schema = spec.value("schema").toObject();
  setWindowTitle(spec.value("title").toString(schema.value("title").toString("my-claude")));
  setMinimumWidth(480);
  auto* outer = new QVBoxLayout(this);
  const QString text = spec.value("text").toString(schema.value("description").toString());
  if (!text.isEmpty()) {
    auto* l = new QLabel(text, this);
    l->setWordWrap(true);
    l->setTextFormat(Qt::PlainText);
    l->setTextInteractionFlags(Qt::TextSelectableByMouse);
    outer->addWidget(l);
  }
  auto* form = new QFormLayout;
  form->setFieldGrowthPolicy(QFormLayout::ExpandingFieldsGrow);
  outer->addLayout(form);
  // sections become tabs when there are several (the Settings dialog)
  int sections = 0;
  for (const auto& v : schema.value("properties").toObject()) sections += v.toObject().value("type").toString() == "object";
  if (sections > 1) {
    tabs_ = new QTabWidget(this);
    outer->addWidget(tabs_, 1);
    resize(760, 620);
  }
  addFields(form, schema, spec.value("values").toObject(), QString());
  for (const QString& k : filters_.keys()) refilter(k);

  auto* buttons = new QDialogButtonBox(this);
  auto* ok = buttons->addButton(spec.value("ok").toString("OK"), QDialogButtonBox::AcceptRole);
  buttons->addButton(spec.value("cancel").toString("Cancel"), QDialogButtonBox::RejectRole);
  ok->setDefault(true);
  connect(buttons, &QDialogButtonBox::accepted, this, &FormDialog::accept);
  connect(buttons, &QDialogButtonBox::rejected, this, &QDialog::reject);
  outer->addWidget(buttons);
  if (!fields_.isEmpty()) fields_.first().widget->setFocus();
  else ok->setFocus();
}

void FormDialog::addFields(QFormLayout* form, const QJsonObject& schema, const QJsonObject& values, const QString& group) {
  const QJsonObject props = schema.value("properties").toObject();
  QStringList required;
  for (const auto& r : schema.value("required").toArray()) required << r.toString();
  // Schema order when given (JSON objects arrive sorted by key), else as they come.
  QStringList keys;
  for (const auto& k : schema.value("order").toArray()) if (props.contains(k.toString())) keys << k.toString();
  for (auto it = props.begin(); it != props.end(); ++it) if (!keys.contains(it.key())) keys << it.key();

  for (const QString& key : keys) {
    const QJsonObject p = props.value(key).toObject();
    const QString type = p.value("type").toString("string");
    const QString format = p.value("format").toString();
    const QString tip = p.value("description").toString();
    const QString label = p.value("title").toString(key) + (required.contains(key) ? " *" : "");
    if (type == "object" && group.isEmpty() && tabs_) {
      // a section of its own: one tab, scrolling when it is long (the shortcuts are)
      auto* page = new QWidget;
      auto* inner = new QFormLayout(page);
      inner->setFieldGrowthPolicy(QFormLayout::ExpandingFieldsGrow);
      if (!tip.isEmpty()) {
        auto* l = new QLabel(tip, page);
        l->setWordWrap(true);
        inner->addRow(l);
      }
      addFields(inner, p, values.value(key).toObject(), key);
      auto* scroll = new QScrollArea(tabs_);
      scroll->setWidgetResizable(true);
      scroll->setFrameShape(QFrame::NoFrame);
      scroll->setWidget(page);
      tabs_->addTab(scroll, p.value("title").toString(key));
      continue;
    }
    if (type == "object" && group.isEmpty()) {
      auto* box = new QGroupBox(p.value("title").toString(key), this);
      auto* inner = new QFormLayout(box);
      inner->setFieldGrowthPolicy(QFormLayout::ExpandingFieldsGrow);
      if (!tip.isEmpty()) {
        auto* l = new QLabel(tip, box);
        l->setWordWrap(true);
        inner->addRow(l);
      }
      addFields(inner, p, values.value(key).toObject(), key);
      form->addRow(box);
      continue;
    }
    const QJsonValue cur = values.contains(key) ? values.value(key) : p.value("default");
    Field f{key, group, type, required.contains(key), nullptr};
    QWidget* row = nullptr;
    if (p.contains("enum") && format == "picker") {
      // many choices with columns, a search box over them, any number ticked: an "array of enum" value
      auto* box = new QWidget(this);
      auto* v = new QVBoxLayout(box);
      v->setContentsMargins(0, 0, 0, 0);
      auto* search = new QLineEdit(box);
      search->setPlaceholderText("Search…");
      search->setClearButtonEnabled(true);
      auto* tw = new QTreeWidget(box);
      tw->setProperty("picker", true); // not the object name: every field's widget is named after its key
      tw->setProperty("note", p.value("note").toString()); // "loading…" while the driver fetches the choices
      setupTable(tw, p);
      QSet<QString> ticked;
      for (const auto& t : cur.toArray()) ticked << t.toString();
      fillTable(tw, p.value("enum").toArray(), rowsOf(p), QString(), &ticked);
      auto* count = new QLabel(box);
      const auto recount = [tw, count] {
        int shown = 0, on = 0;
        for (int k = 0; k < tw->topLevelItemCount(); ++k) { shown += !tw->topLevelItem(k)->isHidden(); on += tw->topLevelItem(k)->checkState(0) == Qt::Checked; }
        const QString note = tw->property("note").toString();
        count->setText(QString("%1 shown · %2 ticked").arg(shown).arg(on) + (note.isEmpty() ? QString() : "   " + note));
      };
      connect(search, &QLineEdit::textChanged, tw, [tw, recount](const QString& q) {
        const QStringList words = q.split(' ', Qt::SkipEmptyParts);
        for (int k = 0; k < tw->topLevelItemCount(); ++k) {
          QStringList cells;
          for (int col = 0; col < tw->columnCount(); ++col) cells << tw->topLevelItem(k)->text(col);
          const QString t = cells.join(' ');
          bool hit = true;
          for (const QString& w : words) hit = hit && t.contains(w, Qt::CaseInsensitive);
          tw->topLevelItem(k)->setHidden(!hit);
        }
        recount();
      });
      connect(tw, &QTreeWidget::itemChanged, tw, [recount](QTreeWidgetItem*, int) { recount(); });
      connect(tw, &QTreeWidget::itemDoubleClicked, tw, [](QTreeWidgetItem* it, int) { it->setCheckState(0, it->checkState(0) == Qt::Checked ? Qt::Unchecked : Qt::Checked); });
      // Enter in the search box ticks the first match
      connect(search, &QLineEdit::returnPressed, tw, [tw] {
        for (int k = 0; k < tw->topLevelItemCount(); ++k) if (!tw->topLevelItem(k)->isHidden()) { tw->topLevelItem(k)->setCheckState(0, Qt::Checked); break; }
      });
      tw->setMinimumHeight(320);
      tw->setMinimumWidth(640);
      v->addWidget(search);
      v->addWidget(tw, 1);
      v->addWidget(count);
      recount();
      f.widget = tw;
      row = box;
      search->setFocus();
    } else if (p.contains("enum") && format == "table") {
      // one choice from rows with columns (`columns` the headers, `enumRows` a row per choice)
      auto* tw = new QTreeWidget(this);
      setupTable(tw, p);
      fillTable(tw, p.value("enum").toArray(), rowsOf(p), cur.toString(), nullptr);
      tw->setMinimumHeight(260);
      tw->setMinimumWidth(640);
      connect(tw, &QTreeWidget::itemDoubleClicked, this, [this] { accept(); });
      f.widget = tw;
    } else if (p.contains("enum") && format == "list") {
      auto* lw = new QListWidget(this);
      const QJsonArray labels = p.value("enumLabels").toArray();
      int i = 0;
      for (const auto& e : p.value("enum").toArray()) {
        auto* it = new QListWidgetItem(i < labels.size() ? labels[i].toString() : e.toVariant().toString(), lw);
        it->setData(Qt::UserRole, e.toVariant());
        if (e == cur) lw->setCurrentItem(it);
        ++i;
      }
      if (!lw->currentItem() && lw->count()) lw->setCurrentRow(0);
      lw->setMinimumHeight(qMin(240, 24 * qMax(3, lw->count()) + 8));
      connect(lw, &QListWidget::itemDoubleClicked, this, [this] { accept(); });
      f.widget = lw;
    } else if (p.contains("enum")) {
      auto* cb = new QComboBox(this);
      const QJsonArray labels = p.value("enumLabels").toArray();
      int i = 0;
      for (const auto& e : p.value("enum").toArray()) {
        cb->addItem(i < labels.size() ? labels[i].toString() : e.toVariant().toString(), e.toVariant());
        if (e == cur) cb->setCurrentIndex(i);
        ++i;
      }
      // format "filter": narrows the list field `filters` to the values "<choice>|…" ("*": all)
      if (format == "filter") {
        const QString target = p.value("filters").toString();
        filters_.insert(target, cb);
        connect(cb, &QComboBox::currentIndexChanged, this, [this, target] { refilter(target); });
      }
      f.widget = cb;
    } else if (type == "boolean") {
      auto* c = new QCheckBox(this);
      c->setChecked(cur.toBool());
      f.widget = c;
    } else if (type == "integer") {
      auto* s = new QSpinBox(this);
      s->setRange(p.value("minimum").toInt(-1000000000), p.value("maximum").toInt(1000000000));
      s->setValue(cur.toInt());
      f.widget = s;
    } else if (type == "number") {
      auto* s = new QDoubleSpinBox(this);
      s->setRange(p.value("minimum").toDouble(-1e12), p.value("maximum").toDouble(1e12));
      s->setDecimals(3);
      s->setValue(cur.toDouble());
      f.widget = s;
    } else if (format == "multiline") {
      auto* e = new QPlainTextEdit(cur.toVariant().toString(), this);
      e->setTabChangesFocus(true);
      e->setPlaceholderText(p.value("placeholder").toString());
      e->setFixedHeight(96);
      f.widget = e;
    } else {
      auto* e = new QLineEdit(cur.toVariant().toString(), this);
      e->setPlaceholderText(p.value("placeholder").toString(p.value("default").toVariant().toString()));
      if (format == "password") e->setEchoMode(QLineEdit::Password);
      f.widget = e;
      if (format == "path") {
        row = new QWidget(this);
        auto* h = new QHBoxLayout(row);
        h->setContentsMargins(0, 0, 0, 0);
        auto* b = new QPushButton("…", row);
        b->setFixedWidth(30);
        b->setAutoDefault(false);
        connect(b, &QPushButton::clicked, this, [e, this] {
          const QString d = QFileDialog::getExistingDirectory(this, "Choose a directory", e->text());
          if (!d.isEmpty()) e->setText(d);
        });
        h->addWidget(e);
        h->addWidget(b);
      }
    }
    f.widget->setToolTip(tip);
    f.widget->setObjectName(group.isEmpty() ? key : group + "." + key);
    fields_ << f;
    form->addRow(label, row ? row : f.widget);
  }
}

// A list field shown filtered by its filter dropdown, if it has one; the selection moves to a
// shown item.
void FormDialog::refilter(const QString& key) {
  QComboBox* cb = filters_.value(key);
  for (const Field& f : fields_) {
    if (auto* tw = qobject_cast<QTreeWidget*>(f.widget); tw && f.key == key && cb) {
      const QString want = cb->currentData().toString();
      for (int k = 0; k < tw->topLevelItemCount(); ++k) tw->topLevelItem(k)->setHidden(want != "*" && !tw->topLevelItem(k)->data(0, Qt::UserRole).toString().startsWith(want + "|"));
      if (!tw->currentItem() || tw->currentItem()->isHidden())
        for (int k = 0; k < tw->topLevelItemCount(); ++k) if (!tw->topLevelItem(k)->isHidden()) { tw->setCurrentItem(tw->topLevelItem(k)); break; }
      continue;
    }
    auto* lw = qobject_cast<QListWidget*>(f.widget);
    if (f.key != key || !lw || !cb) continue;
    const QString want = cb->currentData().toString();
    for (int k = 0; k < lw->count(); ++k) lw->item(k)->setHidden(want != "*" && !lw->item(k)->data(Qt::UserRole).toString().startsWith(want + "|"));
    if (!lw->currentItem() || lw->currentItem()->isHidden())
      for (int k = 0; k < lw->count(); ++k) if (!lw->item(k)->isHidden()) { lw->setCurrentRow(k); break; }
  }
}

// A list's choices arriving while the dialog is open: ticks and the selection stay, the
// search and the filter still apply.
void FormDialog::setChoices(const QString& key, const QJsonArray& choices, const QJsonArray& labels, const QString& note, const QJsonArray& rows) {
  for (const Field& f : fields_) {
    auto* tw = qobject_cast<QTreeWidget*>(f.widget);
    if (f.key != key) continue;
    QJsonArray r = rows;
    if (r.isEmpty()) for (const auto& l : labels) r << QJsonArray{l};
    if (tw && tw->property("picker").toBool()) { // ticks stay, the search still applies
      QSet<QString> ticked;
      for (int k = 0; k < tw->topLevelItemCount(); ++k) if (tw->topLevelItem(k)->checkState(0) == Qt::Checked) ticked << tw->topLevelItem(k)->data(0, Qt::UserRole).toString();
      fillTable(tw, choices, r, QString(), &ticked);
      tw->setProperty("note", note);
      if (auto* search = tw->parentWidget()->findChild<QLineEdit*>()) emit search->textChanged(search->text()); // filter and count again
    } else if (tw) {
      fillTable(tw, choices, r, tw->currentItem() ? tw->currentItem()->data(0, Qt::UserRole).toString() : QString(), nullptr);
      refilter(key);
    } else if (auto* lw = qobject_cast<QListWidget*>(f.widget)) {
      const QString cur = lw->currentItem() ? lw->currentItem()->data(Qt::UserRole).toString() : QString();
      {
        const QSignalBlocker hush(lw);
        lw->clear();
        for (int i = 0; i < choices.size(); ++i) {
          auto* it = new QListWidgetItem(i < labels.size() ? labels[i].toString() : choices[i].toString(), lw);
          it->setData(Qt::UserRole, choices[i].toVariant());
          if (choices[i].toString() == cur) lw->setCurrentItem(it);
        }
      }
      refilter(key);
    }
  }
}

// Headers from `columns`, sortable by clicking them; `sort: [column, "asc"|"desc"]` first.
void FormDialog::setupTable(QTreeWidget* tw, const QJsonObject& p) {
  QStringList heads;
  for (const auto& c : p.value("columns").toArray()) heads << c.toString();
  if (heads.isEmpty()) heads << QString();
  tw->setHeaderLabels(heads);
  tw->setHeaderHidden(heads.size() == 1 && heads[0].isEmpty());
  tw->setRootIsDecorated(false);
  tw->setUniformRowHeights(true);
  tw->setAllColumnsShowFocus(true);
  const QJsonArray sort = p.value("sort").toArray();
  tw->header()->setSortIndicator(sort.isEmpty() ? 0 : sort.at(0).toInt(), sort.at(1).toString() == "desc" ? Qt::DescendingOrder : Qt::AscendingOrder);
  tw->setSortingEnabled(true);
}

// A row per choice: `enumRows`, else the label (or the value) as the only cell.
QJsonArray FormDialog::rowsOf(const QJsonObject& p) {
  if (p.contains("enumRows")) return p.value("enumRows").toArray();
  QJsonArray rows;
  const QJsonArray labels = p.value("enumLabels").toArray(), values = p.value("enum").toArray();
  for (int i = 0; i < values.size(); ++i) rows << QJsonArray{i < labels.size() ? labels[i] : values[i]};
  return rows;
}

// A table's rows, a choice each (its value kept on the row): `ticked` makes them checkable,
// else `cur` stays selected. Sorted by the column the user (or the schema) chose.
void FormDialog::fillTable(QTreeWidget* tw, const QJsonArray& choices, const QJsonArray& rows, const QString& cur, const QSet<QString>* ticked) {
  const QSignalBlocker hush(tw);
  tw->setSortingEnabled(false);
  tw->clear();
  for (int i = 0; i < choices.size(); ++i) {
    QStringList cells;
    for (const auto& c : rows.at(i).toArray()) cells << c.toVariant().toString();
    auto* it = new QTreeWidgetItem(tw, cells.isEmpty() ? QStringList{choices[i].toVariant().toString()} : cells);
    it->setData(0, Qt::UserRole, choices[i].toVariant());
    if (ticked) {
      it->setFlags(it->flags() | Qt::ItemIsUserCheckable);
      it->setCheckState(0, ticked->contains(choices[i].toString()) ? Qt::Checked : Qt::Unchecked);
    } else if (choices[i].toString() == cur) tw->setCurrentItem(it);
  }
  tw->setSortingEnabled(true);
  if (!ticked && !tw->currentItem() && tw->topLevelItemCount()) tw->setCurrentItem(tw->topLevelItem(0));
  for (int c = 0; c < tw->columnCount(); ++c) tw->resizeColumnToContents(c);
}

QJsonValue FormDialog::read(const Field& f) const {
  QWidget* w = f.widget;
  const auto typed = [&](const QVariant& v) -> QJsonValue {
    if (f.type == "integer") return v.toInt();
    if (f.type == "number") return v.toDouble();
    if (f.type == "boolean") return v.toBool();
    return v.toString();
  };
  if (auto* tw = qobject_cast<QTreeWidget*>(w); tw && tw->property("picker").toBool()) {
    QJsonArray a;
    for (int k = 0; k < tw->topLevelItemCount(); ++k) if (tw->topLevelItem(k)->checkState(0) == Qt::Checked) a << QJsonValue::fromVariant(tw->topLevelItem(k)->data(0, Qt::UserRole));
    // nothing ticked: the highlighted one, so arrowing to a repo and pressing Enter adds it
    if (a.isEmpty())
      for (QTreeWidgetItem* it : tw->selectedItems()) if (!it->isHidden()) a << QJsonValue::fromVariant(it->data(0, Qt::UserRole));
    return a;
  }
  if (auto* lw = qobject_cast<QListWidget*>(w)) return lw->currentItem() ? typed(lw->currentItem()->data(Qt::UserRole)) : QJsonValue();
  if (auto* tw = qobject_cast<QTreeWidget*>(w)) return tw->currentItem() && !tw->currentItem()->isHidden() ? typed(tw->currentItem()->data(0, Qt::UserRole)) : QJsonValue();
  if (auto* cb = qobject_cast<QComboBox*>(w)) return typed(cb->currentData());
  if (auto* c = qobject_cast<QCheckBox*>(w)) return c->isChecked();
  if (auto* s = qobject_cast<QSpinBox*>(w)) return s->value();
  if (auto* d = qobject_cast<QDoubleSpinBox*>(w)) return d->value();
  if (auto* t = qobject_cast<QPlainTextEdit*>(w)) return t->toPlainText();
  if (auto* e = qobject_cast<QLineEdit*>(w)) return e->text();
  return QJsonValue();
}

// Every field comes back, empty strings included: whether "empty" means "unset" is for
// the asker to say.
QJsonObject FormDialog::values() const {
  if (answered_) return answer_;
  QJsonObject out;
  for (const Field& f : fields_) {
    if (f.group.isEmpty()) out[f.key] = read(f);
    else {
      QJsonObject g = out.value(f.group).toObject();
      g[f.key] = read(f);
      out[f.group] = g;
    }
  }
  return out;
}

void FormDialog::accept() {
  if (!answered_) {
    for (const Field& f : fields_) {
      if (!f.required) continue;
      const QJsonValue v = read(f);
      if (v.isNull() || (v.isString() && v.toString().trimmed().isEmpty())) {
        f.widget->setFocus();
        f.widget->setStyleSheet("border: 1px solid #ff5f5f;");
        return;
      }
    }
  }
  QDialog::accept();
}
