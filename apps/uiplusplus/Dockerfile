# Use the official Ruby image as the base image
FROM --platform=$BUILDPLATFORM ruby:4.0.8@sha256:155974d81dd535a263a2b9392a7198ebafe0c869a90561cc6dee12b9a34e1b38 AS build

# Set the working directory
WORKDIR /usr/src/app

# Upstream's lockfile only resolves for Windows and pins gems that predate Ruby 3.4, so bring our own.
# It lives outside the app dir, so the site copy below doesn't replace it with upstream's
ENV BUNDLE_GEMFILE=/usr/src/gems/Gemfile
COPY Gemfile Gemfile.lock /usr/src/gems/
RUN bundle install

# Copy the rest of the application code, with upstream's .git for jekyll-last-modified-at
COPY --from=src . .
COPY website/. website/

# BuildKit clones the src context shallowly, so every page would get the pinned commit's date
RUN git fetch --unshallow

# Upstream's _config.yml uses the US/Central alias, which Debian moved to tzdata-legacy. Without it dates render in UTC
RUN apt-get update && apt-get install -y --no-install-recommends tzdata-legacy

# Build the Jekyll site
RUN bundle exec jekyll build --source website --destination _site

# Use the static web server image to serve the built files
FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a

# Copy the built site to the public directory
COPY --from=build /usr/src/app/_site /public

# Expose the port that the static web server will serve on
EXPOSE 4000
