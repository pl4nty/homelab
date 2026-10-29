# Use the official Ruby image as the base image
FROM --platform=$BUILDPLATFORM ruby:3.4.10@sha256:ce3b7a999d9e430e59e1a12456c631fbea3dd18948c89cf8a913c3566c77b2ae AS build

# Set the working directory
WORKDIR /usr/src/app

# Install Jekyll and Bundler
RUN gem install jekyll bundler

# Copy the Gemfile and Gemfile.lock into the container
# kept outside the app dir, so the site copy below doesn't restore the upstream versions
ENV BUNDLE_GEMFILE=/usr/src/gems/Gemfile
COPY --from=src website/Gemfile website/Gemfile.lock /usr/src/gems/

# Install the dependencies
# the lockfile pins bundler 2.2.9, which crashes on Ruby 3.4, and Ruby 3.4 no longer ships csv, base64 and bigdecimal as default gems
RUN sed -i '/^BUNDLED WITH/,$d' /usr/src/gems/Gemfile.lock \
 && printf 'gem "csv"\ngem "base64"\ngem "bigdecimal"\n' >> /usr/src/gems/Gemfile \
 && bundle install

# Copy the rest of the application code
COPY --from=src website/. .
COPY website/. .

# Build the Jekyll site
RUN bundle exec jekyll build

# Use the static web server image to serve the built files
FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a

# Copy the built site to the public directory
COPY --from=build /usr/src/app/_site /public

# Expose the port that the static web server will serve on
EXPOSE 4000
