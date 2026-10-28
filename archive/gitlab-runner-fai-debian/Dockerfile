FROM debian:bookworm

# if [ -d /sys/fs/selinux ]; then mount -t selinuxfs none /sys/fs/selinux; mkdir -p /etc/selinux; touch /etc/selinux/config; fi
# if [ ! -e /proc/sys/fs/binfmt_misc/status ]; then
#   mount -t binfmt_misc binfmt_misc /proc/sys/fs/binfmt_misc
# fi

RUN apt-get update \
  && apt-get install --no-install-recommends -y \
  python3-libcloud python3-marshmallow python3-yaml qemu-utils \
  binfmt-support ca-certificates debsums dosfstools fai-server fai-setup-storage fdisk make python3-pytest qemu-user-static qemu-utils sudo udev curl \
  && apt-get clean
# mount -t tmpfs none /tmp
