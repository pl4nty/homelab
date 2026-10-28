"""Resolve shared MCP runtime objects without duplicating the main module."""

import sys


def _resolve_main_module():
    # When running `python main.py`, use the already-loaded __main__ module.
    main_mod = sys.modules.get("__main__")
    if main_mod is not None and hasattr(main_mod, "mcp"):
        return main_mod

    # Fallback for import-based execution (tests, module mode).
    main_mod = sys.modules.get("main")
    if main_mod is not None and hasattr(main_mod, "mcp"):
        return main_mod

    import main as imported_main
    return imported_main


_main = _resolve_main_module()
mcp = _main.mcp
# graph_client = _main._graph_client
