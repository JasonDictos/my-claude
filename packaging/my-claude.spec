# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# Binary package: build-rpm.sh compiles everything first and passes the staging tree in
# (%{stage}); this spec only lays it out. Fedora, x86_64.
%global debug_package %{nil}
# the compiled my-claude is bun's runtime with the program appended: stripping it cuts the program off
%global __strip /bin/true
%global __brp_strip /bin/true
%global __brp_strip_static_archive /bin/true
%global __brp_strip_comment_note /bin/true

Name:           my-claude
Version:        %{rpm_version}
Release:        %{rpm_release}%{?dist}
Summary:        Claude Code projects: one long-lived session per repo, a tab per project
# mc-term links qtermwidget (GPL-2.0-or-later), so that binary is distributed under the GPL; the source is MIT.
# The compiled my-claude carries bun, and through it JavaScriptCore (LGPL-2.0-or-later).
License:        MIT AND GPL-2.0-or-later AND LGPL-2.0-or-later
URL:            https://github.com/JasonDictos/my-claude
ExclusiveArch:  x86_64
Requires:       tmux >= 3.2
Requires:       git
Requires:       hicolor-icon-theme
Recommends:     universal-ctags
BuildRequires:  systemd-rpm-macros
AutoReqProv:    yes

%description
my-claude makes a project, not a directory, the unit of work: each repo gets its own
long-lived Claude Code session, the sessions of a project sit side by side in tmux or in
a native window (mc-term), know about each other, and come back on the same
conversations after a crash or a reboot. Claude Code itself (claude) is not part of
this package.

%install
install -Dm755 %{stage}/my-claude           %{buildroot}%{_libdir}/my-claude/my-claude
install -Dm755 %{stage}/my-claude.sh        %{buildroot}%{_bindir}/my-claude
install -Dm755 %{stage}/mc-term             %{buildroot}%{_bindir}/mc-term
install -Dm644 %{stage}/mc-term.desktop     %{buildroot}%{_datadir}/applications/mc-term.desktop
install -Dm644 %{stage}/icons/mc-term.svg   %{buildroot}%{_datadir}/icons/hicolor/scalable/apps/mc-term.svg
for n in 16 22 24 32 48 64 128 256 512; do
  install -Dm644 %{stage}/icons/mc-term-$n.png %{buildroot}%{_datadir}/icons/hicolor/${n}x${n}/apps/mc-term.png
done
mkdir -p %{buildroot}%{_datadir}/my-claude/icons
cp -a %{stage}/icons/. %{buildroot}%{_datadir}/my-claude/icons/
install -Dm644 %{stage}/settings.example.json %{buildroot}%{_datadir}/my-claude/settings.example.json
install -Dm644 %{stage}/README.md           %{buildroot}%{_docdir}/%{name}/README.md
install -Dm644 %{stage}/PROTOCOL.md         %{buildroot}%{_docdir}/%{name}/PROTOCOL.md
install -Dm644 %{stage}/my-claude.service  %{buildroot}%{_userunitdir}/my-claude.service
install -Dm644 %{stage}/settings.json     %{buildroot}%{_sysconfdir}/my-claude/settings.json
install -Dm644 %{stage}/LICENSE             %{buildroot}%{_datadir}/licenses/%{name}/LICENSE

%files
%license %{_datadir}/licenses/%{name}/LICENSE
%dir %{_sysconfdir}/my-claude
%config(noreplace) %{_sysconfdir}/my-claude/settings.json
%doc %{_docdir}/%{name}
%{_bindir}/my-claude
%{_bindir}/mc-term
%{_libdir}/my-claude/
%{_datadir}/my-claude/
%{_datadir}/applications/mc-term.desktop
%{_datadir}/icons/hicolor/*/apps/mc-term.*
%{_userunitdir}/my-claude.service

# The service only acts once a user turns auto-restart on (`my-claude service install`).
%post
%systemd_user_post my-claude.service

%preun
%systemd_user_preun my-claude.service
