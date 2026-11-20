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
#include <QPlainTextEdit>
#include <QPushButton>
#include <QSpinBox>
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
      // many choices, a search box over them, any number ticked: an "array of enum" value
      auto* box = new QWidget(this);
      auto* v = new QVBoxLayout(box);
      v->setContentsMargins(0, 0, 0, 0);
      auto* search = new QLineEdit(box);
      search->setPlaceholderText("Search…");
      search->setClearButtonEnabled(true);
      auto* lw = new QListWidget(box);
      lw->setProperty("picker", true); // not the object name: every field's widget is named after its key
      const QJsonArray labels = p.value("enumLabels").toArray();
      QSet<QString> ticked;
      for (const auto& c : cur.toArray()) ticked << c.toString();
      int i = 0;
      for (const auto& e : p.value("enum").toArray()) {
        auto* it = new QListWidgetItem(i < labels.size() ? labels[i].toString() : e.toString(), lw);
        it->setData(Qt::UserRole, e.toVariant());
        it->setFlags(it->flags() | Qt::ItemIsUserCheckable);
        it->setCheckState(ticked.contains(e.toString()) ? Qt::Checked : Qt::Unchecked);
        ++i;
      }
      auto* count = new QLabel(box);
      const auto recount = [lw, count] {
        int shown = 0, on = 0;
        for (int k = 0; k < lw->count(); ++k) { shown += !lw->item(k)->isHidden(); on += lw->item(k)->checkState() == Qt::Checked; }
        count->setText(QString("%1 shown · %2 ticked").arg(shown).arg(on));
      };
      connect(search, &QLineEdit::textChanged, lw, [lw, recount](const QString& q) {
        const QStringList words = q.split(' ', Qt::SkipEmptyParts);
        for (int k = 0; k < lw->count(); ++k) {
          const QString t = lw->item(k)->text();
          bool hit = true;
          for (const QString& w : words) hit = hit && t.contains(w, Qt::CaseInsensitive);
          lw->item(k)->setHidden(!hit);
        }
        recount();
      });
      // a click on the row ticks it, not only on the box; space too
      connect(lw, &QListWidget::itemClicked, lw, [recount](QListWidgetItem* it) { Q_UNUSED(it); recount(); });
      connect(lw, &QListWidget::itemChanged, lw, [recount](QListWidgetItem*) { recount(); });
      connect(lw, &QListWidget::itemDoubleClicked, lw, [](QListWidgetItem* it) { it->setCheckState(it->checkState() == Qt::Checked ? Qt::Unchecked : Qt::Checked); });
      // Enter in the search box ticks the only match, or the first
      connect(search, &QLineEdit::returnPressed, lw, [lw] {
        for (int k = 0; k < lw->count(); ++k) if (!lw->item(k)->isHidden()) { lw->item(k)->setCheckState(Qt::Checked); break; }
      });
      lw->setMinimumHeight(320);
      v->addWidget(search);
      v->addWidget(lw, 1);
      v->addWidget(count);
      recount();
      f.widget = lw;
      row = box;
      search->setFocus();
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

QJsonValue FormDialog::read(const Field& f) const {
  QWidget* w = f.widget;
  const auto typed = [&](const QVariant& v) -> QJsonValue {
    if (f.type == "integer") return v.toInt();
    if (f.type == "number") return v.toDouble();
    if (f.type == "boolean") return v.toBool();
    return v.toString();
  };
  if (auto* lw = qobject_cast<QListWidget*>(w); lw && lw->property("picker").toBool()) {
    QJsonArray a;
    for (int k = 0; k < lw->count(); ++k) if (lw->item(k)->checkState() == Qt::Checked) a << QJsonValue::fromVariant(lw->item(k)->data(Qt::UserRole));
    return a;
  }
  if (auto* lw = qobject_cast<QListWidget*>(w)) return lw->currentItem() ? typed(lw->currentItem()->data(Qt::UserRole)) : QJsonValue();
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
