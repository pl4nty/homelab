# ice-code-editor

Mirror of the [ICE Code Editor](https://github.com/eee-c/ice-code-editor) at <http://gamingjs.com/ice/>, from *3D Game Programming for Kids*, with the libraries its templates load from the site root (`/Three.js`, `/physi.js`, ...). The files in `public/` come from the site's `editor.appcache` manifest (2013-07-20), with these changes:

- `main.dart.js`: `http://gamingJS.com/` is now `/`, so templates load the libraries from the mirror over HTTPS.
- `index.html`: the AppCache manifest and `appcache.js` are removed, because browsers no longer support AppCache.

Projects are kept in the browser's `localStorage`, so projects saved on gamingjs.com do not show here.
