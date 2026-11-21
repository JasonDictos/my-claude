#!/bin/sh
# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# Static archives Alpine does not ship: libXau, libXdmcp, the xcb-util family, libdbus, utf8proc.
set -eux
X=https://www.x.org/releases/individual
auto() { # name url
  curl -fsSL "$2" | tar xJ
  (cd "$1" && ./configure --prefix=$PREFIX --enable-static --disable-shared --with-pic >/dev/null && make -j"$(nproc)" >/dev/null && make install >/dev/null)
}
auto libXau-1.0.12 $X/lib/libXau-1.0.12.tar.xz
auto libXdmcp-1.1.5 $X/lib/libXdmcp-1.1.5.tar.xz
auto xcb-util-0.4.1 $X/lib/xcb-util-0.4.1.tar.xz
auto xcb-util-image-0.4.1 $X/lib/xcb-util-image-0.4.1.tar.xz
auto xcb-util-keysyms-0.4.1 $X/lib/xcb-util-keysyms-0.4.1.tar.xz
auto xcb-util-renderutil-0.3.10 $X/lib/xcb-util-renderutil-0.3.10.tar.xz
auto xcb-util-wm-0.4.2 $X/lib/xcb-util-wm-0.4.2.tar.xz
auto xcb-util-cursor-0.1.5 $X/lib/xcb-util-cursor-0.1.5.tar.xz
# libdbus, the library only
curl -fsSL https://dbus.freedesktop.org/releases/dbus/dbus-1.16.2.tar.xz | tar xJ
meson setup dbus-build dbus-1.16.2 --prefix=$PREFIX -Ddefault_library=static -Dmessage_bus=false -Dtools=false -Dmodular_tests=disabled \
  -Ddoxygen_docs=disabled -Dxml_docs=disabled -Dsystemd=disabled -Dselinux=disabled -Dapparmor=disabled -Dlibaudit=disabled -Dx11_autolaunch=disabled >/dev/null
ninja -C dbus-build >/dev/null && ninja -C dbus-build install >/dev/null
# utf8proc (qtermwidget)
curl -fsSL https://github.com/JuliaStrings/utf8proc/archive/refs/tags/v2.10.0.tar.gz | tar xz
cmake -S utf8proc-2.10.0 -B utf8proc-build -G Ninja -DCMAKE_INSTALL_PREFIX=$PREFIX -DBUILD_SHARED_LIBS=OFF -DCMAKE_POSITION_INDEPENDENT_CODE=ON >/dev/null
cmake --build utf8proc-build >/dev/null && cmake --install utf8proc-build >/dev/null
# dbus-1.pc puts -pthread in Cflags; Qt turns every Cflags word into a -D, and -D-pthread
# is not a macro name
sed -i '/^Cflags:/s/ -pthread//' $PREFIX/lib/pkgconfig/dbus-1.pc
