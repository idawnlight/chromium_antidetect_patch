FROM ubuntu:24.04

RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
    ca-certificates dbus-x11 openbox xvfb xauth x11-xserver-utils x11-utils wmctrl \
    pulseaudio pulseaudio-utils \
    fonts-ubuntu fonts-dejavu-core fonts-liberation2 fonts-noto-core fonts-noto-cjk fonts-noto-color-emoji fontconfig \
    locales tzdata \
    mesa-utils libgl1-mesa-dri libegl1 libglx-mesa0 mesa-vulkan-drivers libvulkan1 libgbm1 \
    libgtk-3-0t64 libnss3 libnspr4 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
    libcups2t64 libxss1 libx11-xcb1 libxcb-dri3-0 libxcomposite1 libxdamage1 libxfixes3 \
    libxrandr2 libxkbcommon0 libpangocairo-1.0-0 libxshmfence1 libglib2.0-bin \
    gsettings-desktop-schemas dconf-gsettings-backend adwaita-icon-theme \
    && locale-gen en_US.UTF-8 \
    && rm -rf /var/lib/apt/lists/* \
    && useradd --uid 10001 --create-home --shell /bin/bash desktop

COPY container/fonts-local.conf /etc/fonts/local.conf
COPY container/start-desktop.sh /usr/local/bin/start-desktop
RUN fc-cache -f && chmod 644 /etc/fonts/local.conf && chmod 755 /usr/local/bin/start-desktop

ENV HOME=/home/desktop LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 LANGUAGE=en_US:en \
    TZ=Etc/UTC DISPLAY=:99 XDG_RUNTIME_DIR=/tmp/desktop-runtime \
    XDG_SESSION_TYPE=x11 XDG_CURRENT_DESKTOP=Openbox DESKTOP_SESSION=openbox
USER desktop
WORKDIR /home/desktop
ENTRYPOINT ["/usr/local/bin/start-desktop"]
