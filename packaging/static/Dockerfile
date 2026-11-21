# SPDX-License-Identifier: MIT
# Copyright (c) 2026 Jason Dictos - my-claude, https://github.com/JasonDictos/my-claude
# A fully static mc-term (musl, Qt and qtermwidget linked in, X11 through xcb): any x86_64 Linux
# with X or XWayland. Staged, so a change to mc-term does not rebuild Qt.
#   packaging/static/build.sh   -> dist/static/mc-term
FROM alpine:3.22 AS base
RUN apk add --no-cache build-base cmake ninja samurai perl python3 linux-headers git curl xz pkgconf meson \
      autoconf automake libtool util-macros xcb-proto xorgproto gperf m4 file patch \
      libxcb-dev libxcb-static libx11-dev libx11-static libxkbcommon-dev libxkbcommon-static \
      fontconfig-dev fontconfig-static freetype-dev freetype-static expat-dev expat-static \
      zlib-dev zlib-static libpng-dev libpng-static brotli-dev brotli-static bzip2-dev bzip2-static \
      libbsd-dev libbsd-static libmd-dev
ENV PREFIX=/opt/static PKG_CONFIG_PATH=/opt/static/lib/pkgconfig:/opt/static/share/pkgconfig
WORKDIR /src

# the small X and D-Bus libraries Alpine ships without static archives
FROM base AS deps
COPY deps.sh /src/deps.sh
RUN sh /src/deps.sh

FROM deps AS qt
ARG QT=6.11.2
RUN curl -fsSL https://download.qt.io/official_releases/qt/${QT%.*}/${QT}/submodules/qtbase-everywhere-src-${QT}.tar.xz | tar xJ && \
    curl -fsSL https://download.qt.io/official_releases/qt/${QT%.*}/${QT}/submodules/qtsvg-everywhere-src-${QT}.tar.xz | tar xJ
RUN cd qtbase-everywhere-src-${QT} && ./configure -prefix /opt/qt -static -release -optimize-size \
      -no-opengl -no-feature-vulkan -no-feature-sql -no-feature-printsupport -no-feature-concurrent \
      -xcb -bundled-xcb-xinput -fontconfig -system-freetype -qt-harfbuzz -qt-pcre -system-zlib -qt-libpng -qt-libjpeg -no-icu \
      -dbus-linked -nomake examples -nomake tests -- -DCMAKE_PREFIX_PATH=/opt/static -DCMAKE_FIND_LIBRARY_SUFFIXES=.a \
    && cmake --build . --parallel && cmake --install .
# (with the static libraries' prefix, or Qt's Gui is not found and Svg quietly builds nothing)
RUN cd qtsvg-everywhere-src-${QT} && /opt/qt/bin/qt-configure-module . -- -DCMAKE_PREFIX_PATH=/opt/static -DCMAKE_FIND_LIBRARY_SUFFIXES=.a && \
    cmake --build . --parallel && cmake --install . && test -f /opt/qt/lib/cmake/Qt6Svg/Qt6SvgConfig.cmake

FROM qt AS qtw
RUN git clone -q --depth 1 --branch 2.4.0 https://github.com/lxqt/lxqt-build-tools.git && \
    cmake -S lxqt-build-tools -B lbt -G Ninja -DCMAKE_PREFIX_PATH=/opt/qt -DCMAKE_INSTALL_PREFIX=/opt/qt && cmake --install lbt
RUN curl -fsSL https://github.com/lxqt/qtermwidget/releases/download/2.4.0/qtermwidget-2.4.0.tar.xz | tar xJ
COPY qtermwidget-static.patch /src/
RUN cd qtermwidget-2.4.0 && patch -p1 < /src/qtermwidget-static.patch && \
    cmake -S . -B build -G Ninja -DCMAKE_BUILD_TYPE=Release -DCMAKE_PREFIX_PATH="/opt/qt;/opt/static" -DCMAKE_INSTALL_PREFIX=/opt/qt \
      -DBUILD_SHARED_LIBS=OFF -DUPDATE_TRANSLATIONS=OFF -DBUILD_EXAMPLE=OFF -DBUILD_DESIGNERPLUGIN=OFF && \
    cmake --build build && cmake --install build

FROM qtw AS mcterm
# only static archives left to link against: where a library has both, the .so link goes
# (link-time names only; nothing here runs against them)
RUN for a in /usr/lib/*.a /opt/static/lib/*.a; do so=${a%.a}.so; [ -e "$so" ] && rm -f "$so"; done; true
COPY host /src/host
RUN cmake -S /src/host -B /build -G Ninja -DCMAKE_BUILD_TYPE=Release -DMC_STATIC=ON -DCMAKE_PREFIX_PATH="/opt/qt;/opt/static" -DCMAKE_FIND_LIBRARY_SUFFIXES=.a && \
    cmake --build /build && strip /build/mc-term && file /build/mc-term
