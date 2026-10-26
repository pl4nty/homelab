#!/usr/bin/env bash
# Copies apps/<app>/deploy to <out>/<app> with the image placeholders filled in.
# Usage: render-deploy.sh <app> <out> <preview|production> [image-repository] [image-tag]
# Only ${APP_IMAGE_REPOSITORY} and ${APP_IMAGE_TAG} are replaced here. Every other
# variable (PUBLIC_DOMAIN, APP_HOST_SUFFIX, ...) is left for Flux post-build substitution.
set -euo pipefail

app=$1 out=$2 mode=$3 repository=${4:-} tag=${5:-}
src=apps/$app/deploy

if [[ ! -d $src ]]; then
  echo "$app has no deploy folder, nothing to render"
  exit 0
fi

mkdir -p "$out/$app"
cp -r "$src/." "$out/$app/"

# previews never get production secrets
if [[ $mode == preview ]]; then
  find "$out/$app" -name '*.sops.yaml' -print -delete
fi

if grep -rqF '${APP_IMAGE_' "$out/$app" && [[ -z $repository || -z $tag ]]; then
  echo "::error::$src uses \${APP_IMAGE_*} but no image was built for $app" >&2
  exit 1
fi

find "$out/$app" -type f \( -name '*.yaml' -o -name '*.yml' \) -exec sed -i \
  -e "s|\${APP_IMAGE_REPOSITORY}|$repository|g" \
  -e "s|\${APP_IMAGE_TAG}|$tag|g" {} +
