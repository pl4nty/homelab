FROM httpd:2.4.58 AS run
RUN apt-get update \
&& apt-get install -y --no-install-recommends gcc make libaprutil1-dev libpq5 \
&& rm -rf /var/lib/apt/lists/*

FROM run AS build
RUN apt-get update \
&& apt-get install -y --no-install-recommends libpq-dev \
&& rm -rf /var/lib/apt/lists/*

FROM build AS mod_certwatch
WORKDIR /app
COPY mod_certwatch .
RUN sed -i -e 's/^\(top_srcdir=\).*/\1\/usr\/local\/apache2/' \
-e '/^DEFS/s/$/ -Wno-format-security -I \/usr\/include\/postgresql/' Makefile
RUN make

FROM build AS mod_pgconn
WORKDIR /app
COPY mod_pgconn .
RUN sed -i -e 's/^\(top_srcdir=\).*/\1\/usr\/local\/apache2/' Makefile \
&& echo 'DEFS=-I /usr/include/postgresql' >> Makefile
RUN make

# shame make install has those deps, doubt the separate stage is worth it
FROM run

WORKDIR /mod_certwatch
COPY --from=mod_certwatch /app ./
RUN make install

WORKDIR /mod_pgconn
COPY --from=mod_pgconn /app ./
RUN make install

RUN printf 'LoadModule certwatch_module modules/mod_certwatch.so\n\
LoadModule pgconn_module modules/mod_pgconn.so\n\
SetHandler certwatch\n\
<Location "/">\n\
  ConnInfo "${CONNINFO}"\n\
  SetHandler certwatch\n\
</Location>\n\
<FilesMatch "\.html$">\n\
  ConnInfo "${CONNINFO}"\n\
  SetHandler certwatch\n\
</FilesMatch>\n' >> /usr/local/apache2/conf/httpd.conf

COPY asn1js/ /usr/local/apache2/htdocs/asn1js/
# remove html, body block like crt.sh, because it has background-color: #C0C0C0
RUN sed -i '1,5d' /usr/local/apache2/htdocs/asn1js/index.css
COPY brand/ /usr/local/apache2/htdocs/
