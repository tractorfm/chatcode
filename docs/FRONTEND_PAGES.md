# Frontend Pages Deploy (app.*)

This repo uses Cloudflare Pages for the web app surface:

- `app.chatcode.dev` (production UI)
- `app.staging.chatcode.dev` (staging UI)
- branch previews on `*.pages.dev` (for feature branches / agent experiments)

Control-plane API remains on `cp.*`.

## 1. Create Pages projects + attach domains

Run once:

```bash
./scripts/setup-pages-app.sh \
  --account-id <CLOUDFLARE_ACCOUNT_ID> \
  --api-token <CLOUDFLARE_API_TOKEN_WITH_PAGES_AND_ZONE_PERMS> \
  --prod-project chatcode-app \
  --staging-project chatcode-app-staging \
  --prod-domain app.chatcode.dev \
  --staging-domain app.staging.chatcode.dev
```

## 2. Configure GitHub Actions

Set repository **secrets**:

- `CLOUDFLARE_API_TOKEN`
- `CLOUDFLARE_ACCOUNT_ID`

Set repository **variables**:

- `CF_PAGES_PROJECT_PROD` = `chatcode-app`
- `CF_PAGES_PROJECT_STAGING` = `chatcode-app-staging`

Workflow: `.github/workflows/web-pages.yml`

## 3. Branch/URL behavior

On push with changes under `packages/web/**`:

- `main` branch -> deploy to prod project, branch `main`  
  target domain: `https://app.chatcode.dev`
- `staging` branch -> deploy to staging project, branch `staging`  
  target domain: `https://app.staging.chatcode.dev`
- any other branch -> deploy preview to staging project, branch `<sanitized-branch>`  
  preview URL: `https://<sanitized-branch>.chatcode-app-staging.pages.dev`

Use `workflow_dispatch` to redeploy a specific branch manually.

## 4. App -> CP host mapping

Frontend should call:

- production app -> `https://cp.chatcode.dev`
- staging/preview app -> `https://cp.staging.chatcode.dev`

Keep this explicit in web env config (do not infer from window hostname).
