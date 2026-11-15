# rctf

[rCTF](https://github.com/redpwn/rctf) with per-member logins. Upstream has one login per team, so every flag, solve and login belongs to the whole team. `rctf.patch` lets each member in a team's member list (the existing prize-eligibility emails) log in as themselves, and records which member did what.

## Logins

- **Team token:** unchanged. The session is the whole team, and it is the only session that can manage the team: members, name, email, division and CTFtime.
- **Member, by email** (needs an email provider): on the account recovery page, a member enters their email and gets a single-use login link. An email that is both the team email and a member email gets both links.
- **Member, by link:** the team's profile has a Copy Login button for each member. The `/login?token=` link does not expire. Anyone with the team token can get any member's link, so this attributes work only within a team that trusts its captain.

Member sessions don't get the team token and can't manage the team. They keep the team's `perms`, so an admin team's members are admins. Deleting a member ends their sessions and makes their link invalid, but keeps their records. Login tokens issued before this patch stay valid as team sessions.

## Records

| Table | Rows | Member columns |
| --- | --- | --- |
| `submissions` | each flag that is checked: `badFlag`, `goodFlag` or `badAlreadySolvedChallenge`, with the flag (first 1024 characters) and IP | `memberid`, `memberemail` (a copy that is kept when the member is deleted) |
| `logins` | each auth token issued: `teamToken`, `memberToken`, `memberEmail`, `recover` or `ctftime`, with IP and user agent | `memberid`, `memberemail` |
| `solves` | unchanged, plus a column | `memberid` |

The table does not record attempts that are rejected before the flag is checked: rate limited, unknown challenge, before or after the CTF, or blocked by `requireMemberLogin`. Registration is not recorded as a login. Each authenticated request's log line also has `member`.

The team's own profile shows who solved each challenge. Public profiles don't.

Admins (`challsRead` permission) can query the records:

```sh
curl -H "Authorization: Bearer $ADMIN_AUTH_TOKEN" "$ORIGIN/api/v1/admin/submissions?userid=<team id>&limit=100&offset=0"
curl -H "Authorization: Bearer $ADMIN_AUTH_TOKEN" "$ORIGIN/api/v1/admin/logins?memberid=<member id>"
```

`/admin/submissions` filters by `userid`, `memberid` and `challengeid`. `/admin/logins` filters by `userid` and `memberid`. Both return the newest rows first, with `limit` up to 1000.

## Config

| Key | Env | Default | Effect |
| --- | --- | --- | --- |
| `userMembers` | `RCTF_USER_MEMBERS` | `true` | upstream's member list; member logins need it |
| `requireMemberLogin` | `RCTF_REQUIRE_MEMBER_LOGIN` | `false` | reject flags from team sessions, so every submission has a member |

`proxy.cloudflare` or `proxy.trust` must be set for the recorded IPs to be clients, not the proxy.

## Upgrading

The migration only adds a column and tables, and `database.migrate: before` runs it. The client is built on upstream's Node 12, because preact-cli 3 fails on newer Node. The server runs on Node 22 (upstream runs it on Node 12, which reached end of life in 2022).
