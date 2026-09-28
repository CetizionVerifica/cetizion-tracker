# Screenshots

The images in the project README, captured from the app running locally.

**The client names in them are invented.** They are shaped like the real data —
same row counts, same currencies, same reference numbers — but every company and
contact was renamed before a single frame was taken. A private repository is not a
reason to commit a list of who Cetizion sells to, and an image is much harder to
scrub afterwards than a line of text.

## Taking them again

Screens change; these will go stale. To redo them:

```bash
# A throwaway database, so nothing touches your development data
createdb cetizion_shots
cd server
for f in schema views seed demo; do psql -d cetizion_shots -f "db/$f.sql"; done
# rename the companies, contacts and salespeople before doing anything else

# Serve the built app from an API pointed at it
cd ../web && npm run build
cd ../server && DATABASE_URL=postgres://localhost:5432/cetizion_shots PORT=4100 \
  AUTH_MODE=shared AUTH_USERNAME=admin AUTH_PASSWORD=<anything> \
  SESSION_SECRET=<32+ chars> WEB_DIST_DIR=../web/dist SKIP_DOTENV=1 npm start
```

Then drive it with Playwright, which `web` already has. Sign in through
`POST /api/auth/login` and hand the cookie to the browser context rather than filling
the form — the sign-in screen is not what is being photographed, and a changed label
should not break the capture.

Captured at 1440 wide, `colorScheme: 'dark'`, at 1× — GitHub renders them around 900px,
so a 2× capture quadruples the bytes for nothing. Give each screen a viewport height
that fits its content, or the frame ends in a field of empty background.

Drop the database afterwards.
