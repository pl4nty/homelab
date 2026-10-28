# sops-editor

Edit sops-encrypted YAML in this repo from a browser, without a Codespace.

Everything runs client-side: the age key decrypts the data key in the browser, values are re-encrypted with the same data key, and the result is committed through the GitHub API. Nothing is sent anywhere else (`connect-src https://api.github.com`).

- Token: fine-grained PAT for this repo with **Contents: read and write**.
- Key: `AGE-SECRET-KEY-1…` (the `SOPS_AGE_KEY` Codespaces secret). Kept in memory unless "Remember" is ticked.
- Branch: commits go to this branch, which is created from the default branch if missing.
- New files use the matching `.sops.yaml` creation rule, encrypted to the recipient of your key.

`src/sops.js` ports the sops YAML store and AES-GCM tree cipher. Unchanged values keep their IVs, so diffs only touch edited values, `lastmodified` and `mac`. Tests encrypt and decrypt against the real `sops` binary.

Not supported: multi-document YAML, anchors/aliases, comment regexes, key groups/Shamir, non-age keys. Deeply nested sequences and comments may be re-indented on save (same YAML).
