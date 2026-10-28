FROM --platform=$BUILDPLATFORM quay.io/curl/curl:8.23.0@sha256:11e64e28c5f58c8d93ee95fcf22ac055f48b0bc440e0ce7d8013bbb5ad6aa8ac AS plugins

RUN mkdir /tmp/plugins
RUN curl -L https://github.com/CTFd/public_challenges/archive/36667c9f0dffc37e42a1cd3df874daf762425d1e.tar.gz | tar xz -C /tmp/plugins
RUN curl -L https://github.com/SunshineCTF/CTFd-scores-ctftime/archive/4b9eaf8f96041980b27625e1deb0725281d9d864.tar.gz | tar xz -C /tmp/plugins
# requires DISCORD_WEBHOOK_URL: https://github.com/sigpwny/ctfd-discord-webhook-plugin/blob/master/config.py
RUN curl -L https://github.com/sigpwny/ctfd-discord-webhook-plugin/archive/c8fac3f999c3028e178de0b376e1981dea7db370.tar.gz | tar xz -C /tmp/plugins
RUN curl -L https://github.com/adb014/CTFd-solutions/archive/8a646c7f08175b271cfc9bf80ddcd8d9a0191ac6.tar.gz | tar xz -C /tmp/plugins

FROM ghcr.io/ctfd/ctfd:3.8.9@sha256:84aff1e50b6a6f931b5da90c6f5b7c623ba4583217a9b00e9d4c1b7c53b9739f

COPY --from=plugins /tmp/plugins CTFd/plugins
# the base image runs pip as ctfd (1001), so its cache needs its own id and owner
RUN --mount=type=cache,id=pip-ctfd,target=/home/ctfd/.cache/pip,uid=1001,gid=1001 \
  for d in CTFd/plugins/*; do \
  if [ -f "$d/requirements.txt" ]; then \
    pip install -r "$d/requirements.txt";\
  fi; \
done;
COPY CTFd-isolated-challenges CTFd/plugins/CTFd-isolated-challenges
