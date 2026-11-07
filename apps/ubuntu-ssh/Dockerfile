FROM ubuntu:24.04@sha256:fe81560990fae86dc4743202b2cb4d3df98d0bcf949173cecef15ce1127ef852

RUN --mount=type=cache,target=/var/cache/apt \
    apt-get update && apt-get install -y --no-install-recommends \
    openssh-server \
    iputils-ping \
    traceroute \
    iproute2

RUN service ssh restart

USER ubuntu
RUN ssh-keygen -A

USER root

CMD ["/usr/sbin/sshd","-D","-p 2222"]
EXPOSE 2222
