target "default" {
  contexts = {
    # the commit gamingjs.com/ice was built from (2013-07-20 appcache); later commits don't match main.dart.js
    src = "https://github.com/eee-c/ice-code-editor.git#4e3ca0667186d397108b8698f351f3e8743d91bd"
  }
}
