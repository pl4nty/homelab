# ice-code-editor

Mirror of the [ICE Code Editor](https://github.com/eee-c/ice-code-editor) at <http://gamingjs.com/ice/>, from *3D Game Programming for Kids*. The editor's own assets (`packages/ice_code_editor/`) come from the commit the site was built from. The dart2js output, Dart's `browser`/`js` shims and the libraries the templates load (`/Three.js`, `/physi.js`, ...) exist only on gamingjs.com, so the Dockerfile downloads them with pinned checksums and patches them:

- `main.dart.js`: `http://gamingJS.com/` becomes `/`, so templates load the libraries from the mirror over HTTPS.
- `index.html`: the AppCache manifest is removed, because browsers no longer support AppCache. A one-line shim names `PointerEvent` `MouseEvent`, because the 2013 dart2js runtime does not know `PointerEvent` and the menu breaks on click (on gamingjs.com too).

Projects are kept in the browser's `localStorage`, so projects saved on gamingjs.com do not show here.
