# Sample app for the apps/ pipeline: a static page served by static-web-server.
FROM busybox:1.37 AS test
COPY public /public
RUN grep -q '<title>hello</title>' /public/index.html

FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a
ENV SERVER_PORT=8080
COPY public /public
