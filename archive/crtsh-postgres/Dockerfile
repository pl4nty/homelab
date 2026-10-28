# TODO linttbscert
FROM golang:1.21.4 AS cert_validation_success_monitor

WORKDIR /app
COPY cert_validation_success_monitor/go.* ./
RUN go mod download

COPY cert_validation_success_monitor/*.go ./
# can't use Makefile, it references SVN
RUN CGO_ENABLED=0 go build cert_validation_success_monitor.go

FROM golang:1.21.4 AS test_websites_monitor

WORKDIR /app
COPY test_websites_monitor/go.* ./
RUN go mod download

COPY test_websites_monitor/*.go test_websites_monitor/*.toml ./
# can't use Makefile, it references SVN
RUN CGO_ENABLED=0 go build -ldflags "-X main.build_date=`date -u +%Y-%m-%d.%H:%M:%S`" test_websites_monitor.go processor_main.go

# 15 perms are incompatible with setup scripts (public schema)
FROM postgres:13.13-bullseye AS buildpg

# build extensions
RUN apt-get update \
&& apt-get install -y --no-install-recommends gcc make postgresql-server-dev-13 ruby2.7-dev pkg-config \
&& rm -rf /var/lib/apt/lists/*

FROM buildpg AS libcablintpq
WORKDIR /app
COPY libcablintpq .
RUN sed -i 's/ruby-2.4/ruby-2.7/g' Makefile
RUN make

FROM buildpg AS libx509lintpq
WORKDIR /app
COPY libx509lintpq .
COPY x509lint/ x509lint/
RUN make

FROM buildpg AS libx509pq
WORKDIR /app
COPY libx509pq .
RUN make

FROM golang:1.21.4-bullseye AS buildgo
RUN apt-get update \
&& apt-get install -y --no-install-recommends postgresql-server-dev-13 \
&& rm -rf /var/lib/apt/lists/*

FROM buildgo AS libocsppq

WORKDIR /libocsppq
COPY libocsppq/go.* ./
RUN GO111MODULE=off go get -u gitlab.com/microo8/plgo/plgo
RUN go mod download

COPY libocsppq .
RUN sed -i 's/\/home\/rob//' Makefile
RUN make

FROM buildgo AS libzlintpq

WORKDIR /libzlintpq
COPY libzlintpq/go.* ./
RUN GO111MODULE=off go get -u gitlab.com/microo8/plgo/plgo
RUN go get -u github.com/zmap/zlint
RUN go mod download

COPY libzlintpq .
RUN sed -i 's/\/home\/rob//' Makefile
RUN make

FROM buildgo AS crlset-tools

WORKDIR /crlset-tools
COPY crlset-tools/crlset.go .
RUN CGO_ENABLED=0 go build -ldflags "-X main.build_date=`date -u +%Y-%m-%d.%H:%M:%S`" crlset.go

FROM postgres:13.13-bullseye

# scripts: wget, ca-certificates, screen, cron, gcc
# libcablintpq: ruby
RUN apt-get update \
&& apt-get install -y --no-install-recommends build-essential llvm-11 wget screen cron ruby2.7 ruby2.7-dev \
&& rm -rf /var/lib/apt/lists/*

COPY --from=libcablintpq /app/ /libcablintpq
RUN cd /libcablintpq && make install

COPY certlint /usr/local/certlint
RUN gem install public_suffix simpleidn
RUN cd /usr/local/certlint/ext && ruby extconf.rb && make

COPY --from=libx509lintpq /app/ /libx509lintpq
RUN cd /libx509lintpq && make install

COPY --from=libx509pq /app/ /libx509pq
RUN cd /libx509pq && make install

COPY --from=libocsppq /libocsppq/ /libocsppq
RUN cd /libocsppq/build && make install with_llvm=no

COPY --from=libzlintpq /libzlintpq/ /libzlintpq
RUN cd /libzlintpq/build && make install with_llvm=no

# database init relative to /. changing psql workdir breaks perms, not sure how to resolve safely
COPY certwatch_db/ .

WORKDIR /docker-entrypoint-initdb.d
COPY certwatch_db/sql/create_schema.sql 1-init.sql z-init.sql ./
RUN sed -i -e 's/EXTENSION libzlintpq/EXTENSION libzlintpq; CREATE EXTENSION libx509pq/' \
-e 's/\\i fnc\/determine_ca_trust_purposes.fnc//' create_schema.sql
RUN printf "\i ca_issuers/ca_issuers.fnc\n\
\i ccadb/apple_disclosures.fnc\n\
\i ccadb/chrome_disclosures.fnc\n\
\i fnc/build_graph.fnc\n\
\i fnc/certification_graph.fnc\n\
\i fnc/pki_hierarchy.fnc\n\
\i fnc/pem_cert.fnc\n\
CREATE TABLE ct_log_entry_2023 PARTITION OF ct_log_entry FOR VALUES FROM ('2023-01-01T00:00:00'::timestamp) TO ('2024-01-01T00:00:00'::timestamp);\n\
ALTER TYPE disclosure_status_type ADD VALUE 'CRLDisclosureIncompleteForPossiblyDormantCA';\n\
ALTER TABLE ocsp_responder ADD COLUMN unencoded_plus_result text;\n\
ALTER TABLE ocsp_responder ADD COLUMN unencoded_plus_dump bytea;\n\
ALTER TABLE ocsp_responder ADD COLUMN unencoded_plus_duration bigint;\n\
ALTER TABLE ccadb_certificate ADD COLUMN cp_cps_last_updated timestamp;\n\
CLUSTER ct_log USING ctl_sha256_pubkey;\n\
CLUSTER ca USING ca_uniq;\n\
CLUSTER crl USING crl_ia_lc;\n\
CREATE EXTENSION libocsppq;" >> create_schema.sql
# TODO CREATE INDEX (UNIQUE?) on ocsp_responder 

COPY libcablintpq/create_functions.sql z1-create_functions.sql
COPY libx509lintpq/create_functions.sql z2-create_functions.sql
RUN sed -i '1s/^/\\connect certwatch postgres\n/' z1-create_functions.sql z2-create_functions.sql

# update_browser_revocations.sh ./crlset output isn't (and never was?) psql COPY-compatible, maybe upstream has an unreleased parser?
# regular_maintenance.sh no clustered index for ocsp_responder
COPY certwatch_db/jobs/*app_monitor.sh /root/
COPY --from=cert_validation_success_monitor /app/cert_validation_success_monitor /cert_validation_success_monitor/cert_validation_success_monitor

WORKDIR /root/certwatch
COPY certwatch_db/ .
RUN echo "export PGHOST=localhost" >> /root/.profile
ENV PGHOST localhost

COPY --from=test_websites_monitor /app/test_websites_monitor /app/*.toml ./test_websites_monitor/bin/
RUN echo 'conninfo = "user=certwatch sslmode=disable"' >> ./test_websites_monitor/bin/test_websites_monitor.toml
RUN sed -i -e 's/ON COMMIT DROP;/ON COMMIT DROP; \\i fnc\/determine_ca_trust_purposes.fnc/' ./sql/determine_ca_trust_purposes.sql

RUN sed -i -e 's/echo -en/echo -n/g' ./jobs/update_accepted_roots.sh
COPY --from=crlset-tools /crlset-tools/crlset ./jobs/
RUN chmod +x ./mozilla_telemetry/update_mozilla_cert_validation_success.sh

WORKDIR /
COPY certwatch_db/jobs/crontab /etc/cron.d/certwatch
RUN chmod 0644 /etc/cron.d/certwatch && crontab /etc/cron.d/certwatch
CMD cron && /usr/local/bin/docker-entrypoint.sh postgres
