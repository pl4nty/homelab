# Whisker Shuffle 🐾

A cat-themed sliding tile puzzle (15-puzzle style). Open `index.html` in any browser — no build, no dependencies, works offline.

- **Arbitrary grid sizes** — rows and columns each adjustable from 2 to 8, rectangles included.
- **Procedural cat art** — every round draws a new flat-illustration cat on a canvas (random fur, pattern, eyes, accessory, background motifs). "New cat" deals a fresh one.
- **Auto-solver** — "Solve it for me" computes a solution for the current position on any grid size and animates it tile by tile. The solver reduces the board row by row and column by column, placing each tile (or end-of-line pair) with an exact BFS over a small abstracted state space, then finishes the last 2×2 exactly.
- Click a tile in the blank's row/column to slide the whole run; arrow keys also work. Move counter, timer, optional tile numbers, light/dark theme, reduced-motion support.

Shuffling is done by a random walk of legal moves from the solved state, so every deal is guaranteed solvable.
