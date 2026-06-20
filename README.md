# IB History Updater

## Setup

```powershell
npm install
Copy-Item .env.example .env
# Set DATABASE_URL in .env.
npm run db:migrate
npm start
```

The existing UI and offline browser cache remain unchanged. Authentication and database access go through the Express API, so `DATABASE_URL` stays server-side.

## Validation

```powershell
npm run build
```

## Deploy from GitHub

1. Push this directory to GitHub.
2. In Render, create a Blueprint and select the repository. `render.yaml` configures the web service.
3. Enter `DATABASE_URL` as a secret environment variable in Render. Never commit `.env`.
4. Deploy and open the generated Render URL.
