# Synapse — Install Guide

Synapse is Manifest V3 Chrome extension. Cognify web pages (articles, PDFs, Google Docs/Slides/Sheets, YouTube transcripts) into Cognee AI memory, organized by project.

Two ways to run backend: **Cognee Cloud** (hosted, easiest) or **local Cognee** (self-host via Docker).

---

## 1. Load the extension in Chrome

1. `chrome://extensions`
2. Enable **Developer mode** (top right)
3. **Load unpacked** → select this repo's root folder (`synapse/`)
4. Pin icon to toolbar if want quick access

Reload extension (⟳ icon on `chrome://extensions` card) after any code/manifest change.

---

## 2. Option A — Cognee Cloud (hosted, default)

No install needed on your side.

1. Go to https://app.cognee.ai → sign up/log in
2. Settings → API Keys → create key (`cognee_...`)
3. In extension: click Synapse icon → gear/settings → paste key into **API Key**
4. Leave **Base URL** as `https://api.cognee.ai` (default)
5. Click **Test Connection** → should show `✓ Connected`

Done. Skip to section 4.

---

## 3. Option B — Local Cognee (self-hosted via Docker)

Use this if want data local, offline dev, or no cloud account.

### 3.1 Clone Cognee

```bash
git clone https://github.com/topoteretes/cognee.git
cd cognee
```

### 3.2 Configure environment

```bash
cp .env.template .env
```

Edit `.env` — minimum required:
- `LLM_API_KEY` — your OpenAI (or other configured provider) key. Cognee needs an LLM for cognify/extraction step.
- Optionally set `LLM_PROVIDER`, `LLM_MODEL`, `EMBEDDING_PROVIDER` if not using OpenAI defaults.

### 3.3 Start via Docker Compose

```bash
docker compose up -d
```

This brings up Cognee API server (default `http://localhost:8000`), plus backing DB services defined in `docker-compose.yml`. First boot may take a bit (pulling images, DB migrations).

Check health:

```bash
curl http://localhost:8000/health
```

### 3.4 Get / set local API key

Local Cognee still expects `X-Api-Key` header on requests. Check Cognee's docs/`.env` for how key is generated for local mode (some setups accept any non-empty string in dev mode, others require a key created via Cognee's own signup flow against local server — verify against the version you cloned).

### 3.5 Point Synapse at local server — manifest edit required

Chrome MV3 blocks cross-origin `fetch` from extension service workers unless origin listed in `host_permissions`. Current `manifest.json` only allows `https://api.cognee.ai/*`. For local Cognee, add local origin:

Edit `manifest.json`:

```json
"host_permissions": [
  "https://api.cognee.ai/*",
  "http://localhost:8000/*",
  "https://docs.google.com/*",
  "https://*.googleusercontent.com/*"
]
```

Then reload extension at `chrome://extensions` (⟳) so new permission takes effect.

### 3.6 Configure extension

1. Synapse → settings
2. **API Key**: your local key
3. **Base URL**: `http://localhost:8000`
4. **Test Connection**

**Known issue:** some Cognee plugin/proxy setups skip sending `X-Api-Key` header for `localhost` targets, causing false `401 Unauthorized` even with correct key. If Test Connection 401s locally, verify with raw curl first:

```bash
curl -H "X-Api-Key: YOUR_KEY" http://localhost:8000/api/v1/datasets
```

If curl succeeds but extension fails, check `background/service-worker.js` `cogneeRequest`/`cogneeFormRequest` header handling and confirm `host_permissions` change from 3.5 was actually reloaded.

<img width="2720" height="2824" alt="synapse_cognify_job_flow_with_integrations" src="https://github.com/user-attachments/assets/426a3576-b29d-418b-86b8-fb2bec36f5f0" />

---

## 4. Verify end-to-end

1. Open any article/webpage
2. Synapse popup → **+ Add Project** → name it, pick/confirm dataset slug
3. Select project card → **Cognify Page**
4. Switch to **Queue** tab → watch job go `Queued → Uploading → Processing → Done`
5. Confirm data landed: `GET {baseUrl}/api/v1/datasets` (cloud) or query via Cognee's search/`app.cognee.ai` UI (cloud) or local API `/api/v1/search`

---

## Notes / gotchas

- API key stored in `chrome.storage.local` — unencrypted, local to browser profile. Don't share machine/profile if key sensitive.
- Job payloads (page content blobs) held in IndexedDB (`synapse-jobs`) until upload; cleared after successful/failed upload.
- Background queue polls every 1 min via `chrome.alarms` — don't need popup open for jobs to progress.
- Switching Base URL later doesn't need manifest edit again as long as target origin already in `host_permissions`.
- Google Docs/Slides/Sheets export requires being signed into Google in browser (extension uses `credentials: 'include'` fetch to docs.google.com export endpoints).
