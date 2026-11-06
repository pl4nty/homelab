# gamingjs.com/ice is a GitHub Pages site with no public source repo, so fetch the files it serves (checksums pin the 2013 build)
FROM --platform=$BUILDPLATFORM busybox@sha256:a46257e06c82ad85242d0d38077d0a52d9896389ca60a1a59d3463db586e5fa4 AS site
WORKDIR /public
ADD --chmod=0644 --checksum=sha256:e34608a631f7b49e1bae5c998b05b442edd2463bd5880cca2f393e44365732b2 http://gamingjs.com/ice/index.html ./
ADD --chmod=0644 --checksum=sha256:6741d5c22984312009b5f8a1cdeb391cf65843558a5c89f3ac3262d85e6119fa http://gamingjs.com/ice/main.dart.js ./
ADD --chmod=0644 --checksum=sha256:9de429871038c4f1d92b7fc238cb27fcfb06c918018424d529442d21de14543e http://gamingjs.com/ice/packages/browser/dart.js ./packages/browser/
ADD --chmod=0644 --checksum=sha256:0765fff52ba19a6d35fcc6116e93be31a75c079f36e0ecc8ee049b3402fe22b5 http://gamingjs.com/ice/packages/browser/interop.js ./packages/browser/
ADD --chmod=0644 --checksum=sha256:aa2b6104417184f1ddc40b0a89d511fb5d80cf0dfa59ecdf919942e990cce580 http://gamingjs.com/ice/packages/js/dart_interop.js ./packages/js/
ADD --chmod=0644 --checksum=sha256:7fa6e2f484258cb787291adccdc503661f90dd27430f4ec4d2ab88f25f4a4fc8 http://gamingjs.com/favicon.ico ./
ADD --chmod=0644 --checksum=sha256:844003ddca9c5cf88a5988cc48f094499b649943812327e57c2bb94808dde6a2 http://gamingjs.com/Three.js ./
ADD --chmod=0644 --checksum=sha256:e56ff11af628cb6292a6de247f31e78dabcf9b8a7389ae2416a3a2bf99030262 http://gamingjs.com/ChromeFixes.js ./
ADD --chmod=0644 --checksum=sha256:1169d54bedda5a58c408a6c5f3b02edc58bf90d811c3165b135e5d7a6f9a029a http://gamingjs.com/Tween.js ./
ADD --chmod=0644 --checksum=sha256:dd181eab6e27989bfdeac832c9da42f66c44758d8ffadff7f77457d6610de9e9 http://gamingjs.com/Detector.js ./
ADD --chmod=0644 --checksum=sha256:90dd810ab6b7585b1c08d6034a312d397d41ddc0b3a7aefc65ef686deca45fdc http://gamingjs.com/Mouse.js ./
ADD --chmod=0644 --checksum=sha256:774652b41495de89c5a31d18124bceef2eb240c6e9138c689600220b5f2b4962 http://gamingjs.com/Scoreboard.js ./
ADD --chmod=0644 --checksum=sha256:4eadbf1c0f0bd7f6e22844beeaf071b4f3bd6dc8d68bdae49d38b8625aff2091 http://gamingjs.com/physi.js ./
ADD --chmod=0644 --checksum=sha256:e8cfc5255f1cc1297b7228599c2915be58f33e67a16ceda444fd9407ba2e23da http://gamingjs.com/physijs_worker.js ./
ADD --chmod=0644 --checksum=sha256:15e3f4da2d09b9d92893fe32330585ab6781ea18a90ba8d8fe82fca3a0f24b28 http://gamingjs.com/ammo.js ./
# drop AppCache (browsers removed it), keep Cloudflare Rocket Loader off the Dart shims, and load the template libraries from this mirror over HTTPS.
# 2013 dart2js maps DOM classes by constructor name and predates PointerEvent (clicks since Chrome 92), so the menu threw NoSuchMethodError on click
RUN sed -i -e 's/ manifest="editor.appcache"//' -e '/appcache\.js/d' -e 's|<script src="packages/|<script data-cfasync="false" src="packages/|' \
    -e 's|<head>|<head><script data-cfasync="false">Object.defineProperty(PointerEvent, "name", { value: "MouseEvent" })</script>|' index.html \
  && sed -i 's|http://gamingJS.com/|/|g' main.dart.js

FROM joseluisq/static-web-server:2.44.1@sha256:94618e3d17802265a21926217e6f9e7832b311b6fbf5933684001739fafed06a
COPY --from=site /public /public
COPY --from=src lib /public/packages/ice_code_editor
