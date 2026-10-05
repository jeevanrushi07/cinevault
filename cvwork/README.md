# CineVault — Supabase + Vercel

This version uses Supabase Auth + PostgreSQL for persistent multi-user data. The frontend remains vanilla JavaScript and the TMDB proxy runs as Vercel serverless functions.

## 1. Supabase

Create a Supabase project. Open **SQL Editor** and run `supabase-schema.sql` from this project.

For the requested username/password login, CineVault internally maps each username to a private synthetic email (`username@cinevault.local`). In Supabase Authentication settings, turn **Confirm email** off. Users still log in only with username + password through CineVault.

Do not put a Supabase service-role/secret key in the browser or in this repository.

## 2. Vercel environment variables

Add these variables to the Vercel project:

- `SUPABASE_URL` — your Supabase project URL
- `SUPABASE_PUBLISHABLE_KEY` — your Supabase publishable/anon client key
- `TMDB_API_KEY` — your TMDB API key

Redeploy after adding them.

## 3. Deploy

Import this folder/repository into Vercel. No Next.js framework is required. The project is vanilla JavaScript with Vercel serverless functions under `/api`.

## 4. Features wired to Supabase

- Username/password accounts
- Separate library per user
- Watched and want-to-watch status
- Movie notes
- User search
- Share/retrieve movies
- Shared-with-me inbox
- Character collection
- Row Level Security
- Persistent data across devices
