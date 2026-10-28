FROM quay.io/curl/curl:8.21.0@sha256:7c12af72ceb38b7432ab85e1a265cff6ae58e06f95539d539b654f2cfa64bb13 AS plugins

RUN mkdir /tmp/plugins
RUN curl -L https://github.com/CTFd/public_challenges/archive/36667c9f0dffc37e42a1cd3df874daf762425d1e.tar.gz | tar xz -C /tmp/plugins
RUN curl -L https://github.com/SunshineCTF/CTFd-scores-ctftime/archive/4b9eaf8f96041980b27625e1deb0725281d9d864.tar.gz | tar xz -C /tmp/plugins
# requires DISCORD_WEBHOOK_URL: https://github.com/sigpwny/ctfd-discord-webhook-plugin/blob/master/config.py
RUN curl -L https://github.com/sigpwny/ctfd-discord-webhook-plugin/archive/c8fac3f999c3028e178de0b376e1981dea7db370.tar.gz | tar xz -C /tmp/plugins
RUN curl -L https://github.com/adb014/CTFd-solutions/archive/8a646c7f08175b271cfc9bf80ddcd8d9a0191ac6.tar.gz | tar xz -C /tmp/plugins

FROM ghcr.io/ctfd/ctfd:3.8.6@sha256:5b780b3628f2fe7bc0cdf9567d51244c2e8b5bb93f227fdac0532c94ae43f7c7

COPY --from=plugins /tmp/plugins CTFd/plugins
RUN for d in CTFd/plugins/*; do \
  if [ -f "$d/requirements.txt" ]; then \
    pip install --no-cache-dir -r "$d/requirements.txt";\
  fi; \
done;
COPY CTFd-isolated-challenges CTFd/plugins/CTFd-isolated-challenges
