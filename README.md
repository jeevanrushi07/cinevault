# CineVault — complete Vercel + Supabase version

CineVault is a vanilla JavaScript movie/series archive using Vercel serverless functions, Supabase PostgreSQL/Auth, and TMDB metadata.

## Authentication

The user-facing authentication is **username + password only**. No email is requested from the user.

Supabase Auth internally requires an email-style identifier, so the server creates a private random internal email for each account. This identifier is never shown to users. Passwords are handled by Supabase Auth; they are not stored as plaintext in the profiles table.

## Supabase setup

1. Create/open the CineVault Supabase project.
2. Run `supabase/schema.sql` in Supabase SQL Editor.
3. Ensure Email provider is enabled under Authentication -> Providers.
4. Email confirmation does not need to be enabled because the server creates confirmed internal Auth users.

For a new database, also run `supabase/social_features.sql` in Supabase SQL Editor after `schema.sql`. For an existing database, run `supabase/library_sharing.sql` if library sharing is not already installed, then run `supabase/social_features.sql`. This adds network chat and notifications for messages and library-sharing changes. Existing per-movie shares are not converted automatically.

## Vercel environment variables

Set these in Vercel Project Settings -> Environment Variables:

- `SUPABASE_URL`
- `SUPABASE_PUBLISHABLE_KEY`
- `SUPABASE_SERVICE_ROLE_KEY` — server only; NEVER put this in frontend code or GitHub.
- `TMDB_API_KEY`

After adding/changing environment variables, redeploy.

## Deploy

This is a vanilla JavaScript Vercel project. No Next.js setup is required.

The public frontend consists of `index.html`, `app.js`, and `styles.css`. Serverless functions are under `api/`.

## Main features

- Username/password accounts
- Unique usernames
- Separate movie libraries per user
- Watched / want-to-watch states
- TMDB live title search
- Top-bar search filters your archive, separates already-saved titles, and finds titles to add as watched or want-to-watch
- Top-right logout control
- Profile pictures from online URLs, watched movie posters, or character images (no image upload)
- Network directory with private messaging
- Notification bell for new messages and library-sharing changes
- Movie titles open a web search for that title
- Movie details, cast, director, trailer and metadata
- Personal movie notes
- Search across title/cast/director/genre/year
- Read-only sharing of watched and want-to-watch libraries
- 1-day, 1-week, 1-month, or until-revoked sharing
- 1-hour and custom-expiry library access
- Incoming and outgoing library shares with immediate revocation
- Character collection
- Supabase Row Level Security
- Persistent data across devices
