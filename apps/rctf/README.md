# rctf

[otter-sec/rctf](https://github.com/otter-sec/rctf) v2.1.6 with each submission linked to the browser that sent it. Teams share one login, so upstream's submission log can only tell submitters apart by IP. `rctf.patch` adds a browser ID.

## Browser ID

The API gives each client an `rctf_browser` cookie: a random UUID, `HttpOnly`, `SameSite=Lax`, `Secure` when `origin` is HTTPS, kept for 400 days. Each flag and admin bot submission records it, and the user agent (first 512 characters), in `submission_logs.details`, as `browserId` and `userAgent`. It is also in each API log line, as `browserId`.

- The ID identifies a cookie jar, not a person. A private window, another browser or cleared cookies get a new ID, and people who share a browser share one.
- Anyone can send any ID, so treat it as a hint, like the IP.
- A client that sends no cookie, such as a script, gets no `browserId`. Its responses issue one, which a client that keeps cookies sends from then on.
- Upstream already records the IP, the submitted flag and a `cheated` result for another team's dynamic flag.

## Admin view

On Admin → Submissions, expand a submission to see its browser and user agent. Select the browser to show only its submissions. The **Browser** filter lists the browsers in the loaded submissions; "No browser cookie" matches submissions without one. The API takes the same filter:

```sh
curl -X POST -H "Authorization: Bearer $ADMIN_TOKEN" -H 'Content-Type: application/json' \
  -d '{"browser": {"include": ["<browser id>"]}}' "$ORIGIN/api/v2/admin/submissions?limit=100&offset=0"
```

```sql
SELECT details->>'browserId' AS browser, user_id, count(*)
FROM submission_logs GROUP BY 1, 2 ORDER BY 3 DESC;
```

The filter scans `details` without an index, which is fine for one CTF's submissions.

## Build

The Dockerfile builds the patched API and web app with upstream's steps, and copies them over `ghcr.io/otter-sec/rctf:v2.1.6`, so nginx, supervisord and the CLI are upstream's. The patch adds no dependencies and no migration. To upgrade, bump the `src` commit in `docker-bake.hcl` and the image in the `Dockerfile` together, then rebase the patch.
