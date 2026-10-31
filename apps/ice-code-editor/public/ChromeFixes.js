// workaround for chrome bug:
// http://code.google.com/p/chromium/issues/detail?id=35980#c12
if (window.innerWidth === 0) {
  window.innerWidth = parent.innerWidth;
  window.innerHeight = parent.innerHeight;
}
