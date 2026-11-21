# rctf

[otter-sec/rctf](https://github.com/otter-sec/rctf) v2.1.6, recording which browser sent each flag submission. Teams share one login, so upstream's submission log can only tell submitters apart by IP.

`rctf.patch` gives each client a random `rctf_browser` cookie (`HttpOnly`, 400 days). Each flag result stores the ID the browser sent, and its user agent, in `submission_logs.details` as `browserId` and `userAgent`. Admin → Submissions shows them when you expand a submission, and API log lines include `browserId`.

- The ID identifies a cookie jar, not a person, and anyone can send any ID: treat it as a hint, like the IP.
- A client that sends no cookie, such as a script, is recorded without a `browserId`.

To group a team's submissions by browser:

```sql
SELECT user_id, details->>'browserId' AS browser, details->>'userAgent' AS agent, count(*)
FROM submission_logs GROUP BY 1, 2, 3 ORDER BY 1, 4 DESC;
```

The Dockerfile rebuilds the patched API and web app and copies them over `ghcr.io/otter-sec/rctf:v2.1.6`. To upgrade, bump the `src` commit in `docker-bake.hcl` and the image in the `Dockerfile` together, then rebase the patch.
