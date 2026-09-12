# Deploying the staff console

The console is a Next.js app with **server-side API routes** — the read proxies
(`/api/core`, `/api/blnk`) and the one write route (`/api/compliance/flag`) run
on the server so the API keys never reach the browser. That rules out a static
host (GitHub Pages, plain S3): it needs a Node/serverless runtime. **Vercel** is
the zero-config fit; any Node host works too.

## Posture

No authentication, on purpose: the core behind it holds **synthetic demo data**,
not real member records, so the console ships open the same way the compliance
dashboard does. If it is ever pointed at real data, put a gate in front first
(Vercel deployment protection is the fastest — password or team SSO — and needs
no code change).

## Environment

Four variables, all server-side (no `NEXT_PUBLIC_` prefix — see
`.env.local.example`). Set them in the host, not in a committed file:

| var | value |
|---|---|
| `CORE_API_URL` | `https://jynsipdvrgqdkeqrlzcv.functions.supabase.co/api` |
| `CORE_API_KEY` | the `DEMO_API_KEY` from the repo-root `.env.local` |
| `BLNK_API_URL` | the Blnk ledger base, from the repo-root `.env.local` |
| `BLNK_API_KEY` | the Blnk key, from the repo-root `.env.local` |

## Vercel (recommended)

Vercel's Git integration auto-deploys on every push to `main` — no workflow file
or CI secrets needed.

1. In the Vercel dashboard: **New Project → import this repo**.
2. Set **Root Directory** to `ui` (the app is not at the repo root). Framework
   preset auto-detects as Next.js; build command `next build`, output handled by
   the preset.
3. Add the four environment variables above (Production, Preview, Development).
4. **Deploy.** Vercel builds `ui/` and serves the API routes as functions.
5. (If it ever holds real data) **Settings → Deployment Protection →** enable
   password or SSO.

The core's `GET /compliance/dashboard` already 302s to this deployment's
`/compliance/dashboard` (the `DEFAULT_SHELL_URL` default in
`core/supabase/functions/api/dashboard.ts`). Set `DASHBOARD_SHELL_URL` on the
core to override it — e.g. a preview deploy or a custom domain.

## Any Node host (Fly, Render, Railway, a container)

```bash
cd ui
npm ci
npm run build
npm run start   # serves on $PORT (default 3000)
```

Set the same four environment variables in the host, and route the port. The
build is a standard `next build`; there is no custom server.
