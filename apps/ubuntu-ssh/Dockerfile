FROM ubuntu:26.04@sha256:d66b366dac61b575bee2aef07e9c26e8070096fbe84a3d4d3eb0da069b5d76db

RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    iputils-ping \
    traceroute \
    iproute2

RUN service ssh restart

RUN echo ubuntu:ubuntu | chpasswd

RUN rm /etc/profile.d/80-systemd-osc-context.sh

USER ubuntu
RUN ssh-keygen -A

USER root

CMD ["/usr/sbin/sshd","-D","-p 2222","-o","ListenAddress=127.0.0.1","-o","ListenAddress=::1"]
EXPOSE 2222
