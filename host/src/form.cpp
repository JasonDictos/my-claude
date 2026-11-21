// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
#include "form.h"
#include "syskeys.h"
#include <QKeyEvent>
#include <QMessageBox>
#include <QStyle>
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
    if (format == "keys") {
      // the whole width: the table, and under it how to use it
      auto* box = new QWidget(this);
      auto* v = new QVBoxLayout(box);
      v->setContentsMargins(0, 0, 0, 0);
      auto* kt = new KeyTable(p, cur.toArray(), box);
      kt->setMinimumHeight(380);
      kt->setMinimumWidth(680);
      v->addWidget(kt, 1);
      if (const QString hint = p.value("hint").toString(); !hint.isEmpty()) {
        auto* l = new QLabel(hint, box);
        l->setWordWrap(true);
        l->setObjectName("hint");
        v->addWidget(l);
      }
      f.widget = kt;
      kt->setObjectName(group.isEmpty() ? key : group + "." + key);
      fields_ << f;
      form->addRow(box);
      continue;
    }
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
  if (auto* kt = qobject_cast<KeyTable*>(w)) return kt->value();
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

// ---- the Shortcuts table ---------------------------------------------------------------

namespace {
// sorted by text, the Enabled column by its tick
struct KeyRow : QTreeWidgetItem {
  using QTreeWidgetItem::QTreeWidgetItem;
  bool operator<(const QTreeWidgetItem& o) const override {
    const int c = treeWidget() ? treeWidget()->sortColumn() : 0;
    if (c == 3) return checkState(3) < o.checkState(3);
    return text(c).localeAwareCompare(o.text(c)) < 0;
  }
};
int keyCode(const QString& k) { return QKeySequence(k.trimmed(), QKeySequence::PortableText)[0].toCombined(); }
} // namespace

KeyTable::KeyTable(const QJsonObject& p, const QJsonArray& values, QWidget* parent) : QTreeWidget(parent) {
  system_ = p.value("system").toBool();
  setHeaderLabels({"Action", "Key", "Custom key", "Enabled"});
  setRootIsDecorated(false);
  setUniformRowHeights(true);
  setAllColumnsShowFocus(true);
  setSelectionMode(QAbstractItemView::SingleSelection);
  QHash<QString, QJsonObject> vals;
  for (const auto& v : values) vals.insert(v.toObject().value("id").toString(), v.toObject());
  QList<int> all;
  for (const auto& rv : p.value("rows").toArray()) {
    const QJsonObject r = rv.toObject(), v = vals.value(r.value("id").toString());
    auto* it = new KeyRow(this);
    it->setText(Action, r.value("action").toString());
    it->setData(Action, Qt::UserRole, r.value("id").toString());
    it->setData(Action, Qt::UserRole + 1, r.value("global").toBool());
    it->setToolTip(Action, r.value("tip").toString(r.value("action").toString()));
    it->setText(Stock, r.value("stock").toString());
    it->setText(Custom, v.value("custom").toString());
    it->setFlags((it->flags() | Qt::ItemIsUserCheckable) & ~Qt::ItemIsEditable);
    it->setCheckState(On, v.value("enabled").toBool(true) ? Qt::Checked : Qt::Unchecked);
    if (r.value("global").toBool()) { QFont f = it->font(Action); f.setBold(true); it->setFont(Action, f); }
    for (const QString& k : (it->text(Stock) + "," + it->text(Custom)).split(',', Qt::SkipEmptyParts)) all << keyCode(k);
    paintRow(it);
  }
  header()->setSortIndicator(-1, Qt::AscendingOrder); // the order given (the menus'), until a header is clicked
  setSortingEnabled(true);
  for (int c = 0; c < columnCount(); ++c) resizeColumnToContents(c);
  header()->setStretchLastSection(false);
  header()->setSectionResizeMode(Action, QHeaderView::Stretch);
  connect(this, &QTreeWidget::itemClicked, this, [this](QTreeWidgetItem* it, int col) { if (col == Custom) startCapture(it); });
  connect(this, &QTreeWidget::itemChanged, this, [this](QTreeWidgetItem* it, int col) { if (col == On) toggled(it); });
  askDesktop(all, [] {});
}

QTreeWidgetItem* KeyTable::row(const QString& id) const {
  for (int k = 0; k < topLevelItemCount(); ++k) if (topLevelItem(k)->data(Action, Qt::UserRole).toString() == id) return topLevelItem(k);
  return nullptr;
}

QJsonArray KeyTable::value() const {
  QJsonArray out;
  for (int k = 0; k < topLevelItemCount(); ++k) {
    const QTreeWidgetItem* it = topLevelItem(k);
    const QString custom = it == capturing_ ? before_ : it->text(Custom);
    out << QJsonObject{{"id", it->data(Action, Qt::UserRole).toString()}, {"custom", custom}, {"enabled", it->checkState(On) == Qt::Checked}};
  }
  return out;
}

// Off: none. Its own key, when it has one; else the shipped ones.
QList<int> KeyTable::keysOf(QTreeWidgetItem* it) const {
  QList<int> out;
  if (it->checkState(On) != Qt::Checked) return out;
  const QString custom = it == capturing_ ? before_ : it->text(Custom);
  for (const QString& k : (custom.isEmpty() ? it->text(Stock) : custom).split(',', Qt::SkipEmptyParts)) if (int c = keyCode(k)) out << c;
  return out;
}

QTreeWidgetItem* KeyTable::holder(int key, QTreeWidgetItem* except) const {
  for (int k = 0; k < topLevelItemCount(); ++k) {
    QTreeWidgetItem* it = topLevelItem(k);
    if (it != except && keysOf(it).contains(key)) return it;
  }
  return nullptr;
}

// The shipped keys greyed when not in use; a key the desktop takes first, flagged.
void KeyTable::paintRow(QTreeWidgetItem* it) {
  const QSignalBlocker hush(this);
  const bool on = it->checkState(On) == Qt::Checked;
  it->setForeground(Stock, palette().color(on && it->text(Custom).isEmpty() ? QPalette::Active : QPalette::Disabled, QPalette::Text));
  it->setForeground(Action, palette().color(on ? QPalette::Active : QPalette::Disabled, QPalette::Text));
  QStringList held;
  if (!it->data(Action, Qt::UserRole + 1).toBool())
    for (int k : keysOf(it)) if (desktop_.contains(k)) held << QKeySequence(k).toString(QKeySequence::NativeText) + " is " + desktop_.value(k) + "'s";
  const int col = it->text(Custom).isEmpty() ? Stock : Custom;
  it->setIcon(Stock, QIcon());
  it->setIcon(Custom, QIcon());
  if (!held.isEmpty()) it->setIcon(col, style()->standardIcon(QStyle::SP_MessageBoxWarning));
  it->setToolTip(Stock, held.isEmpty() ? QString("Shipped with my-claude") : held.join("\n") + " (a desktop-wide key): it never reaches my-claude");
  it->setToolTip(Custom, held.isEmpty() || col != Custom ? QString("Click, then press the keys (Esc clears)") : held.join("\n") + ": it never reaches my-claude");
}

void KeyTable::startCapture(QTreeWidgetItem* it) {
  endCapture();
  capturing_ = it;
  before_ = it->text(Custom);
  const QSignalBlocker hush(this);
  it->setText(Custom, "press the keys… (Esc clears)");
  setCurrentItem(it);
  setFocus();
}

void KeyTable::endCapture() {
  if (!capturing_) return;
  QTreeWidgetItem* it = capturing_;
  capturing_ = nullptr;
  const QSignalBlocker hush(this);
  it->setText(Custom, before_);
}

// While a key is being taken, every key is the table's: not the dialog's Enter or Esc.
bool KeyTable::event(QEvent* e) {
  if (e->type() == QEvent::ShortcutOverride && capturing_) { e->accept(); return true; }
  return QTreeWidget::event(e);
}

void KeyTable::keyPressEvent(QKeyEvent* e) {
  if (!capturing_) {
    if (e->key() == Qt::Key_F2 && currentItem()) { startCapture(currentItem()); return; }
    QTreeWidget::keyPressEvent(e);
    return;
  }
  e->accept();
  int k = e->key();
  static const QSet<int> alone{Qt::Key_Shift, Qt::Key_Control, Qt::Key_Alt, Qt::Key_Meta, Qt::Key_AltGr, Qt::Key_Super_L, Qt::Key_Super_R, Qt::Key_CapsLock, Qt::Key_NumLock, 0, Qt::Key_unknown};
  if (alone.contains(k)) return; // a modifier on its own: the rest of the combination is coming
  QTreeWidgetItem* it = capturing_;
  const Qt::KeyboardModifiers mods = e->modifiers() & (Qt::ControlModifier | Qt::AltModifier | Qt::ShiftModifier | Qt::MetaModifier);
  endCapture();
  if (k == Qt::Key_Escape && mods == Qt::NoModifier) { setCustom(it, QString()); return; }
  if (k == Qt::Key_Backtab) k = Qt::Key_Tab; // Shift+Tab arrives as Backtab, Shift and all
  offer(it, QKeySequence(QKeyCombination(mods, Qt::Key(k))).toString(QKeySequence::PortableText));
}

void KeyTable::focusOutEvent(QFocusEvent* e) {
  endCapture();
  QTreeWidget::focusOutEvent(e);
}

// A key pressed for a row: refused if the desktop holds it; asked about if another row has it.
void KeyTable::offer(QTreeWidgetItem* it, const QString& key) {
  const int k = keyCode(key);
  askDesktop({k}, [this, it, key, k] {
    // the show/hide key is a desktop key itself: it takes its key over, as it always has
    if (!it->data(Action, Qt::UserRole + 1).toBool() && desktop_.contains(k)) {
      tell("Key held by the desktop", QString("%1 is %2's, a desktop-wide key: pressed, it never reaches my-claude.\n\nPick another key, or free %1 in System Settings › Shortcuts.")
                                         .arg(QKeySequence(k).toString(QKeySequence::NativeText), desktop_.value(k)));
      return;
    }
    QTreeWidgetItem* other = it->checkState(On) == Qt::Checked ? holder(k, it) : nullptr;
    if (!other) { setCustom(it, key); return; }
    confirm("Key in use", QString("%1 is the key of “%2”.\n\nGive it to “%3”, and turn “%2” off?").arg(QKeySequence(k).toString(QKeySequence::NativeText), other->text(Action), it->text(Action)),
            "Give it", [this, it, other, key](bool yes) {
              if (!yes) return;
              { const QSignalBlocker hush(this); other->setCheckState(On, Qt::Unchecked); }
              paintRow(other);
              setCustom(it, key);
            });
  });
}

void KeyTable::setCustom(QTreeWidgetItem* it, const QString& key) {
  { const QSignalBlocker hush(this); it->setText(Custom, key); }
  paintRow(it);
}

// Turned on: a key another row has is asked about, and that row turned off.
void KeyTable::toggled(QTreeWidgetItem* it) {
  if (it->checkState(On) != Qt::Checked) { paintRow(it); return; }
  QList<QTreeWidgetItem*> others;
  QStringList what;
  for (int k : keysOf(it))
    if (QTreeWidgetItem* o = holder(k, it); o && !others.contains(o)) { others << o; what << QString("%1 is the key of “%2”").arg(QKeySequence(k).toString(QKeySequence::NativeText), o->text(Action)); }
  if (others.isEmpty()) { paintRow(it); return; }
  confirm("Key in use", QString("Turn on “%1”?\n\n%2: it would be turned off.").arg(it->text(Action), what.join(";\n")), "Turn on", [this, it, others](bool yes) {
    const QSignalBlocker hush(this);
    if (yes) for (QTreeWidgetItem* o : others) { o->setCheckState(On, Qt::Unchecked); paintRow(o); }
    else it->setCheckState(On, Qt::Unchecked);
    paintRow(it);
  });
}

// `then` once the desktop has said who holds these keys (at once when it has, or is not asked).
void KeyTable::askDesktop(const QList<int>& keys, std::function<void()> then) {
  QList<int> fresh;
  for (int k : keys) if (k && !asked_.contains(k)) fresh << k;
  if (!system_ || (fresh.isEmpty() && !pending_)) { then(); return; }
  waiting_ << then;
  if (fresh.isEmpty()) return;
  for (int k : fresh) asked_.insert(k);
  ++pending_;
  systemKeyOwners(fresh, this, [this](const QHash<int, QString>& owners) {
    desktop_.insert(owners);
    for (int k = 0; k < topLevelItemCount(); ++k) paintRow(topLevelItem(k));
    if (--pending_) return;
    const auto ready = waiting_;
    waiting_.clear();
    for (const auto& f : ready) f();
  });
}

void KeyTable::tell(const QString& title, const QString& text) {
  auto* mb = new QMessageBox(QMessageBox::Warning, title, text, QMessageBox::Ok, this);
  mb->setAttribute(Qt::WA_DeleteOnClose);
  mb->open();
}

void KeyTable::confirm(const QString& title, const QString& text, const QString& ok, std::function<void(bool)> answer) {
  auto* mb = new QMessageBox(QMessageBox::Question, title, text, QMessageBox::NoButton, this);
  mb->setAttribute(Qt::WA_DeleteOnClose);
  QAbstractButton* yes = mb->addButton(ok, QMessageBox::AcceptRole);
  mb->addButton(QMessageBox::Cancel);
  mb->setDefaultButton(static_cast<QPushButton*>(yes));
  connect(mb, &QMessageBox::finished, this, [mb, yes, answer] { answer(mb->clickedButton() == yes); });
  mb->open();
}

void KeyTable::capture(const QString& id, int key, Qt::KeyboardModifiers mods) {
  QTreeWidgetItem* it = row(id);
  if (!it) return;
  startCapture(it);
  QKeyEvent press(QEvent::KeyPress, key, mods);
  keyPressEvent(&press);
}

void KeyTable::setEnabledRow(const QString& id, bool on) {
  if (QTreeWidgetItem* it = row(id)) it->setCheckState(On, on ? Qt::Checked : Qt::Unchecked);
}
