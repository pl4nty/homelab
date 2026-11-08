target "default" {
  contexts = {
    # main after v0.3.1: npm's 0.3.1 (2026-06) lacks half the tools and the autocomplete "Place not found" fix.
    # No renovate comment, because it only tracks branches: bump by hand, or switch to the npm package once a release catches up
    src = "https://github.com/shaikhspeare/wanderlog-mcp.git#66a386d65efd34de30987414a15d652937d2a636"
  }
}
