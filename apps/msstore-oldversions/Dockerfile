FROM --platform=$BUILDPLATFORM python:3.14-slim@sha256:ce40764625a4ff50df3548277632e7f96c4e77fe75fa848aae9885476e7df5a4 AS build
WORKDIR /app
COPY msstore_versions.py .
RUN python msstore_versions.py --help

FROM scratch
COPY --from=build /app/msstore_versions.py /
