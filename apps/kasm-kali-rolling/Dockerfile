FROM kasmweb/kali-rolling-desktop:1.19.0-rolling-weekly AS base

USER root
WORKDIR /tmp                                   # keep root droppings out of $HOME
RUN echo 'kasm-user ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/kasm-user && \
    chmod 0440 /etc/sudoers.d/kasm-user        # sudoers.d, not appending to /etc/sudoers

FROM base AS linux-amd64

RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update && apt-get install -y --no-install-recommends \
    sudo kali-linux-default \
    libgmp3-dev libmpc-dev \
    python3 python3-pip python3-venv python3-dev git libssl-dev libffi-dev build-essential \
    python3-pwntools python3-pypykatz \
    autopsy ghidra burpsuite steghide radare2 hashcat binwalk wireshark \
    gdb gdb-peda libimage-exiftool-perl ltrace gimp audacity qsstv strace \
    gfortran qemu-system-x86 jq

RUN wget --no-hsts -q https://github.com/pwndbg/pwndbg/releases/download/2025.05.30/pwndbg_2025.05.30_amd64.deb && \
    apt-get install -y ./pwndbg_2025.05.30_amd64.deb && rm pwndbg_2025.05.30_amd64.deb

RUN gem install zsteg

# --- tooling into /opt, NOT $HOME ---
# own venv: RsaCtfTool pins old cryptography/requests/psutil, and pip can't
# replace Kali's dist-packages anyway (dpkg ships no RECORD to uninstall from)
RUN python3 -m venv /opt/RsaCtfTool && \
    /opt/RsaCtfTool/bin/pip install --no-cache-dir git+https://github.com/RsaCtfTool/RsaCtfTool.git
# caesum.com no longer serves Stegsolve, so pin a mirror of the original jar
ADD --checksum=sha256:007b49606678f39962edadb875e5ae4ac588ea0588c51deefcde3c8dc4fae55a --chmod=0755 \
    https://raw.githubusercontent.com/eugenekolo/sec-tools/68e4c11cdfb69a54a34ae0918d85a2791a677c87/stego/stegsolve/stegsolve/stegsolve.jar /opt/stegsolve.jar
RUN wget --no-hsts -q https://github.com/volatilityfoundation/volatility/releases/download/2.6.1/volatility_2.6_lin64_standalone.zip -O /tmp/vol.zip && \
    unzip -j /tmp/vol.zip volatility_2.6_lin64_standalone/volatility_2.6_lin64_standalone -d /opt && \
    mv /opt/volatility_2.6_lin64_standalone /opt/vol.py && chmod 0755 /opt/vol.py && rm /tmp/vol.zip
RUN wget --no-hsts -q https://github.com/icsharpcode/AvaloniaILSpy/releases/download/v7.2-rc/Linux.x64.Release.zip -O /tmp/ilspy.zip && \
    unzip -q /tmp/ilspy.zip -d /tmp/ilspy && \
    unzip -q /tmp/ilspy/ILSpy-linux-x64-Release.zip -d /opt/AvaloniaILSpy && \
    rm -rf /tmp/ilspy.zip /tmp/ilspy
RUN ln -sf /opt/vol.py /usr/local/bin/vol.py && \
    ln -sf /opt/RsaCtfTool/bin/rsacrack /usr/local/bin/rsacrack && \
    ln -sf /opt/RsaCtfTool/bin/RsaCtfTool /usr/local/bin/RsaCtfTool && \
    ln -sf /opt/RsaCtfTool/bin/RsaCtfTool /usr/local/bin/RsaCtfTool.py

FROM base AS linux-arm64

RUN wget --no-hsts -q https://github.com/icsharpcode/AvaloniaILSpy/releases/download/v7.2-rc/Linux.arm64.Release.zip -O /tmp/ilspy.zip && \
    unzip -q /tmp/ilspy.zip -d /tmp/ilspy && \
    unzip -q /tmp/ilspy/ILSpy-linux-arm64-Release.zip -d /opt/AvaloniaILSpy && \
    rm -rf /tmp/ilspy.zip /tmp/ilspy

ARG TARGETOS TARGETARCH
FROM ${TARGETOS}-${TARGETARCH} AS final

# --- required Kasm tail: applies to BOTH arches, fixes the arm64-runs-as-root bug ---
USER root
ENV HOME=/home/kasm-user
RUN rm -f $HOME/.wget-hsts /home/kasm-default-profile/.wget-hsts && \
    mkdir -p $HOME && \
    chown -R 1000:0 $HOME && \
    $STARTUPDIR/set_user_permission.sh $HOME
USER 1000
WORKDIR $HOME
