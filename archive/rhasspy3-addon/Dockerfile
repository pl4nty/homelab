# from rhasspy3-en/Dockerfile
FROM rhasspy/rhasspy3-addon-base:en-0.0.1 as build
ARG TARGETOS TARGETARCH

RUN apt-get update && \
    apt-get install --yes --no-install-recommends \
    alsa-utils

COPY rhasspy3/programs/wake/porcupine1/ /app/config/programs/wake/porcupine1/
RUN /app/config/programs/wake/porcupine1/script/setup && \
    rm -rf /root/.cache/
COPY Professor_en_${TARGETOS}-${TARGETARCH}_v2_2_0.ppn config/data/wake/porcupine1/porcupine_linux.ppn
