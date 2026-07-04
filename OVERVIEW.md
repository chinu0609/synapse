# What is Synapse?

Synapse is a Chrome extension (Manifest V3) that turns the pages you read into a personal, searchable AI memory. It's a thin, browser-native front end for [Cognee](https://www.cognee.ai/)'s knowledge graph engine — you point it at any article, PDF, Google Doc/Slide/Sheet, or YouTube video, click **Cognify**, and Synapse extracts that content and stores it in a Cognee dataset tied to whichever "project" you're currently working on. Later, you switch to the Chat tab and ask questions about anything you've cognified — Cognee answers using its knowledge graph over your saved content, not a generic web search.

Think of it as: bookmark → but the bookmark actually reads itself into a memory you can talk to.

## Core concept: Projects → Datasets

Everything in Synapse is organized around **projects**. Each project you create maps 1:1 to a Cognee dataset (identified by a slug, e.g. `netflix_data_analysis`). This keeps unrelated research cleanly separated — your recipe notes don't get mixed into your work project's knowledge graph. You pick the active project before cognifying a page, and that page's content lands only in that project's dataset.

## What it does

- **Cognify any page** — one click extracts the current tab's content and queues it for upload:
  - Regular web pages: cleaned via Mozilla Readability (strips nav/ads/boilerplate).
  - PDFs: fetched directly (including PDFs that don't end in `.pdf` but are served as one, e.g. arXiv).
  - Google Docs/Slides/Sheets: exported as PDF via Google's own export endpoints (requires being signed into Google).
  - YouTube videos: scrapes the video's own transcript panel (DOM-based, since YouTube blocks unauthenticated scripted access to its caption API) and cognifies the transcript text.
- **Background job queue** — cognify jobs run through upload → processing → done/error stages, visible in the Queue tab, and keep progressing via a `chrome.alarms`-driven poll even if the popup/side panel is closed. Jobs can be stopped mid-flight, which also cleans up the partial data Cognee already received.
- **Chat tab** — pick a project, ask it questions in natural language. Toggle **Fast** (`GRAPH_COMPLETION`) vs **Deep** (`GRAPH_COMPLETION_COT`) mode depending on whether you want a quick answer or more thorough graph reasoning.
- **Sync from Cognee** — a ⟳ button on the Cognify tab pulls the list of datasets that already exist in your Cognee account and adds any missing ones as local projects, so Synapse stays in sync if you created datasets from another client or a previous install.
- **Project lifecycle** — creating a project checks the dataset name isn't already taken in Cognee; deleting a project deletes its Cognee dataset too (with confirmation that the remote delete actually succeeded before removing it locally).

## How it's built

- **Manifest V3**, no remote code — all logic ships in the extension bundle; the only network calls are data fetches (JSON/PDF/HTML) to Cognee's API and to the page being cognified, never executed as code.
- **`popup/`** — the side panel UI (Cognify / Queue / Chat tabs) and all page-content extraction logic (`chrome.scripting.executeScript` injected into the active tab).
- **`background/service-worker.js`** — owns the job queue (backed by `chrome.storage.local` for job metadata, IndexedDB for the raw payload bytes), talks to the Cognee API, and runs independently of whether the UI is open.
- **`options/`** — where you configure your Cognee API key and base URL (cloud or self-hosted).
- Storage: your API key and settings live in `chrome.storage.local` (local to your browser profile, never synced or transmitted anywhere except your configured Cognee backend).

## Why it exists

Most "save for later" tools just dump a URL in a list you never revisit. Synapse's bet is that the useful unit isn't the link — it's the knowledge the page contained, organized by the project you're actually working on, and queryable later without having to re-read the page.
