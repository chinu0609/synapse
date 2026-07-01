const PROJECT_COLORS = [
  '#6366f1', '#ec4899', '#f59e0b', '#10b981',
  '#3b82f6', '#ef4444', '#8b5cf6', '#06b6d4'
];

let projects = [];
let activeProjectId = null;
let isProcessing = false;

function generateId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function slugify(name) {
  return name.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
}

async function loadState() {
  const data = await chrome.storage.local.get(['projects', 'activeProjectId', 'cogneeApiKey']);
  projects = data.projects || [];
  activeProjectId = data.activeProjectId || null;

  if (!data.cogneeApiKey) {
    showWarning();
  }

  renderProjects();
  updateCognifyBtn();
}

function showWarning() {
  const existing = document.getElementById('apiWarning');
  if (existing) return;
  const banner = document.createElement('div');
  banner.id = 'apiWarning';
  banner.className = 'warning-banner';
  banner.innerHTML = `⚠ No API key — <a href="#" id="goSettings" style="color:#fbbf24;text-decoration:underline;">open settings</a>`;
  document.querySelector('.section-label').before(banner);
  document.getElementById('goSettings').addEventListener('click', (e) => {
    e.preventDefault();
    chrome.runtime.openOptionsPage();
  });
}

function renderProjects() {
  const list = document.getElementById('projectList');
  const emptyState = document.getElementById('emptyState');

  const cards = list.querySelectorAll('.project-card');
  cards.forEach(c => c.remove());

  if (projects.length === 0) {
    emptyState.style.display = 'block';
    return;
  }
  emptyState.style.display = 'none';

  projects.forEach(project => {
    const card = document.createElement('div');
    card.className = 'project-card' + (project.id === activeProjectId ? ' selected' : '');
    card.dataset.id = project.id;
    card.innerHTML = `
      <div class="project-dot" style="background:${project.color}"></div>
      <span class="project-name">${escapeHtml(project.name)}</span>
      <button class="delete-btn" data-id="${project.id}" title="Delete">×</button>
    `;
    card.addEventListener('click', (e) => {
      if (e.target.classList.contains('delete-btn')) return;
      selectProject(project.id);
    });
    card.querySelector('.delete-btn').addEventListener('click', (e) => {
      e.stopPropagation();
      deleteProject(project.id);
    });
    list.appendChild(card);
  });
}

function escapeHtml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

async function selectProject(id) {
  activeProjectId = id;
  await chrome.storage.local.set({ activeProjectId: id });
  renderProjects();
  updateCognifyBtn();
  clearStatus();
}

async function addProject(name, customSlug) {
  if (!name.trim()) return;
  const slug = customSlug ? slugify(customSlug) : slugify(name);
  if (!slug) {
    setStatus('Invalid dataset name.', 'error');
    return;
  }
  if (projects.some(p => p.slug === slug)) {
    setStatus('Dataset name already in use.', 'error');
    return;
  }

  const { cogneeApiKey } = await chrome.storage.local.get('cogneeApiKey');
  if (cogneeApiKey) {
    setStatus('Checking dataset name against Cognee...', 'loading');
    try {
      const response = await chrome.runtime.sendMessage({ type: 'DATASET_EXISTS', datasetName: slug });
      if (response?.success) {
        if (response.exists) {
          setStatus(`✗ Dataset "${slug}" already exists in Cognee. Choose a different name.`, 'error');
          return;
        }
        clearStatus();
      } else {
        setStatus(`⚠ Couldn't verify dataset name against Cognee (${response?.error || 'unknown error'}) — added anyway.`, 'error');
      }
    } catch (err) {
      setStatus(`⚠ Couldn't verify dataset name against Cognee: ${err.message} — added anyway.`, 'error');
    }
  }

  const color = PROJECT_COLORS[projects.length % PROJECT_COLORS.length];
  const project = { id: generateId(), name: name.trim(), slug, color };
  projects.push(project);
  await chrome.storage.local.set({ projects });
  activeProjectId = project.id;
  await chrome.storage.local.set({ activeProjectId: project.id });
  renderProjects();
  updateCognifyBtn();
}

async function deleteProject(id) {
  const project = projects.find(p => p.id === id);
  if (!project) return;

  const card = document.querySelector(`.project-card[data-id="${id}"]`);
  const deleteBtn = card?.querySelector('.delete-btn');
  if (deleteBtn) deleteBtn.disabled = true;

  setStatus(`Deleting "${project.name}" dataset from Cognee...`, 'loading');

  let remoteOk = false;
  let skipped = false;
  let errorMsg = '';
  try {
    const response = await chrome.runtime.sendMessage({ type: 'DELETE_DATASET', datasetName: project.slug });
    remoteOk = !!response?.success;
    skipped = !!response?.skipped;
    if (!remoteOk) errorMsg = response?.error || 'unknown error';
  } catch (err) {
    errorMsg = err.message;
  }

  if (!remoteOk) {
    if (deleteBtn) deleteBtn.disabled = false;
    setStatus(
      `✗ "${project.name}" kept — its Cognee dataset could not be deleted (${errorMsg}). ` +
      `The dataset may be in use elsewhere (e.g. open in Cognee's dashboard/graph view). Try again shortly.`,
      'error'
    );
    return;
  }

  projects = projects.filter(p => p.id !== id);
  if (activeProjectId === id) {
    activeProjectId = projects.length > 0 ? projects[0].id : null;
    await chrome.storage.local.set({ activeProjectId });
  }
  await chrome.storage.local.set({ projects });
  renderProjects();
  updateCognifyBtn();

  setStatus(
    skipped
      ? `✓ "${project.name}" removed (no dataset existed on Cognee yet).`
      : `✓ "${project.name}" and its Cognee dataset were deleted.`,
    'success'
  );
}

function updateCognifyBtn() {
  const btn = document.getElementById('cognifyBtn');
  btn.disabled = !activeProjectId || isProcessing;
}

function setStatus(msg, type = '') {
  const area = document.getElementById('statusArea');
  area.textContent = msg;
  area.className = 'status-area ' + type;
}

function clearStatus() {
  setStatus('');
}

function detectKind(url) {
  let m = url.match(/^https:\/\/docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: 'gdoc', fetchUrl: `https://docs.google.com/document/d/${m[1]}/export?format=pdf`, ext: 'pdf', mime: 'application/pdf' };

  m = url.match(/^https:\/\/docs\.google\.com\/presentation\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: 'gslides', fetchUrl: `https://docs.google.com/presentation/d/${m[1]}/export/pdf`, ext: 'pdf', mime: 'application/pdf' };

  m = url.match(/^https:\/\/docs\.google\.com\/spreadsheets\/d\/([a-zA-Z0-9_-]+)/);
  if (m) return { kind: 'gsheet', fetchUrl: `https://docs.google.com/spreadsheets/d/${m[1]}/export?format=pdf`, ext: 'pdf', mime: 'application/pdf' };

  if (/\.pdf($|\?)/i.test(url)) {
    return { kind: 'pdf', fetchUrl: url, ext: 'pdf', mime: 'application/pdf' };
  }

  if (/^https:\/\/(www\.|m\.)?youtube\.com\/watch\?/.test(url) || /^https:\/\/youtu\.be\//.test(url)) {
    return { kind: 'youtube' };
  }

  return { kind: 'html' };
}

async function getTabContentType(tabId) {
  try {
    const [result] = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => document.contentType
    });
    return result?.result || '';
  } catch {
    return '';
  }
}

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

async function fetchBinaryJob(info, tabTitle) {
  const res = await fetch(info.fetchUrl, { credentials: 'include' });
  if (!res.ok) throw new Error(`Failed to fetch file (HTTP ${res.status}).`);

  const contentType = res.headers.get('content-type') || '';
  if (info.kind !== 'pdf' && !contentType.includes('pdf')) {
    throw new Error('Export did not return a PDF — check you are signed in to Google.');
  }

  const buffer = await res.arrayBuffer();
  const safeName = slugify(tabTitle || 'document') || 'document';
  return {
    filename: `${safeName}.${info.ext}`,
    mime: info.mime,
    dataBase64: arrayBufferToBase64(buffer)
  };
}

async function extractHtmlJob(tab) {
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['lib/Readability.js']
  });

  const [extractResult] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: () => {
      try {
        const documentClone = document.cloneNode(true);
        const article = new Readability(documentClone).parse();
        if (article && article.textContent?.trim()) {
          return {
            title: article.title || document.title || '',
            content: article.textContent.trim(),
            byline: article.byline || '',
            excerpt: article.excerpt || '',
            url: location.href
          };
        }
        // Readability couldn't isolate an article (dashboards, SPAs, non-article
        // layouts) — fall back to raw visible text instead of hard-failing.
        const fallbackText = document.body?.innerText?.trim() || '';
        if (!fallbackText) return { error: 'No readable content found on this page.' };
        return {
          title: document.title || '',
          content: fallbackText,
          byline: '',
          excerpt: '',
          url: location.href
        };
      } catch (e) {
        return { error: e.message };
      }
    }
  });

  const extracted = extractResult?.result;
  if (!extracted || extracted.error) {
    throw new Error(extracted?.error || 'Failed to extract page content.');
  }
  if (!extracted.content) {
    throw new Error('No readable content found on this page.');
  }

  const text = [
    `Title: ${extracted.title || 'Untitled'}`,
    `URL: ${extracted.url || ''}`,
    extracted.byline ? `Author: ${extracted.byline}` : null,
    '',
    extracted.content
  ].filter(line => line !== null).join('\n');

  return {
    title: extracted.title,
    filename: 'page.txt',
    mime: 'text/plain',
    dataBase64: textToBase64(text)
  };
}

function textToBase64(text) {
  return btoa(unescape(encodeURIComponent(text)));
}

async function extractYoutubeJob(tab) {
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    func: async () => {
      const sleep = (ms) => new Promise(r => setTimeout(r, ms));

      function findByLabel(pattern) {
        const candidates = document.querySelectorAll(
          'button, tp-yt-paper-button, ytd-button-renderer, ytd-menu-service-item-renderer'
        );
        for (const el of candidates) {
          const label = (el.getAttribute?.('aria-label') || el.textContent || '').trim();
          if (pattern.test(label)) return el;
        }
        return null;
      }

      try {
        // Read the transcript straight from YouTube's own "Show transcript"
        // panel — the network caption endpoint now blocks scripted fetches
        // (needs a proof-of-origin token only the real player can produce),
        // but the panel just displays whatever the player already loaded.
        let panel = document.querySelector('ytd-transcript-renderer, ytd-transcript-segment-list-renderer');

        if (!panel) {
          let btn = findByLabel(/show transcript/i);

          if (!btn) {
            const moreBtn = findByLabel(/^more actions$/i);
            if (moreBtn) {
              moreBtn.click();
              await sleep(500);
              btn = findByLabel(/show transcript/i);
            }
          }

          if (!btn) {
            return { error: 'Could not find YouTube\'s "Show transcript" button on this video.' };
          }

          btn.click();

          for (let i = 0; i < 20 && !panel; i++) {
            await sleep(250);
            panel = document.querySelector('ytd-transcript-renderer, ytd-transcript-segment-list-renderer');
          }
        }

        if (!panel) {
          return { error: 'Transcript panel did not open. This video may not have a transcript.' };
        }

        for (let i = 0; i < 20; i++) {
          if (panel.querySelectorAll('ytd-transcript-segment-renderer').length > 0) break;
          await sleep(250);
        }

        const segments = Array.from(panel.querySelectorAll('ytd-transcript-segment-renderer'));
        if (segments.length === 0) {
          return { error: 'Transcript panel opened but contained no segments.' };
        }

        const text = segments
          .map(seg => (seg.querySelector('.segment-text')?.textContent || seg.textContent || '').trim())
          .filter(Boolean)
          .join(' ')
          .replace(/\s+/g, ' ')
          .trim();

        if (!text) return { error: 'Transcript was empty.' };

        const title = document.title.replace(/\s*-\s*YouTube\s*$/, '').trim();
        return { title, content: text, url: location.href };
      } catch (e) {
        return { error: e.message };
      }
    }
  });

  const extracted = result?.result;
  if (!extracted || extracted.error) {
    throw new Error(extracted?.error || 'Failed to extract YouTube transcript.');
  }

  const text = [
    `Title: ${extracted.title || 'Untitled'}`,
    `URL: ${extracted.url || ''}`,
    '',
    extracted.content
  ].join('\n');

  return {
    title: extracted.title,
    filename: 'transcript.txt',
    mime: 'text/plain',
    dataBase64: textToBase64(text)
  };
}

async function enqueueActiveTab() {
  if (isProcessing || !activeProjectId) return;

  const project = projects.find(p => p.id === activeProjectId);
  if (!project) return;

  const { cogneeApiKey } = await chrome.storage.local.get('cogneeApiKey');
  if (!cogneeApiKey) {
    setStatus('No API key set. Open settings.', 'error');
    return;
  }

  isProcessing = true;
  updateCognifyBtn();
  document.getElementById('cognifyBtnText').textContent = 'Extracting...';
  document.getElementById('spinner').style.display = 'block';
  setStatus('Reading page content...', 'loading');

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

    if (!tab?.id || !tab.url) throw new Error('No active tab found.');

    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://') || tab.url.startsWith('about:')) {
      throw new Error('Cannot cognify browser system pages.');
    }

    let info = detectKind(tab.url);

    if (info.kind === 'html') {
      // Some PDFs (e.g. arxiv.org/pdf/<id>) don't end in .pdf — check the
      // actual served content-type before assuming it's a normal web page.
      const contentType = await getTabContentType(tab.id);
      if (contentType === 'application/pdf') {
        info = { kind: 'pdf', fetchUrl: tab.url, ext: 'pdf', mime: 'application/pdf' };
      }
    }

    let payload;

    if (info.kind === 'html') {
      payload = await extractHtmlJob(tab);
    } else if (info.kind === 'youtube') {
      payload = await extractYoutubeJob(tab);
    } else {
      payload = await fetchBinaryJob(info, tab.title);
    }

    const response = await chrome.runtime.sendMessage({
      type: 'ENQUEUE_JOB',
      title: payload.title || tab.title || payload.filename,
      datasetName: project.slug,
      projectName: project.name,
      projectColor: project.color,
      kind: info.kind,
      filename: payload.filename,
      mime: payload.mime,
      dataBase64: payload.dataBase64,
      url: tab.url
    });

    if (response?.success) {
      setStatus(`✓ Queued for "${project.name}" — see Queue tab`, 'success');
      refreshQueue();
    } else {
      throw new Error(response?.error || 'Failed to queue job.');
    }
  } catch (err) {
    setStatus(`✗ ${err.message}`, 'error');
  } finally {
    isProcessing = false;
    document.getElementById('cognifyBtnText').textContent = 'Cognify Page';
    document.getElementById('spinner').style.display = 'none';
    updateCognifyBtn();
  }
}

// --- Queue tab ---

const STAGE_PERCENT = {
  queued: 0,
  uploading: 10,
  initiated: 35,
  started: 70,
  completed: 100,
  errored: 100
};

const STAGE_LABEL = {
  queued: 'Queued',
  uploading: 'Uploading',
  initiated: 'Processing',
  started: 'Processing',
  completed: 'Done',
  errored: 'Error'
};

let queuePollTimer = null;

function renderQueue(jobs) {
  const list = document.getElementById('queueList');
  const emptyState = document.getElementById('queueEmptyState');
  const badge = document.getElementById('queueBadge');

  list.querySelectorAll('.job-row').forEach(el => el.remove());

  if (!jobs || jobs.length === 0) {
    emptyState.style.display = 'block';
  } else {
    emptyState.style.display = 'none';
    jobs.slice().reverse().forEach(job => {
      const row = document.createElement('div');
      row.className = 'job-row';
      const pct = STAGE_PERCENT[job.stage] ?? 0;
      const label = STAGE_LABEL[job.stage] || job.stage;
      const fillClass = job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : '';
      const isActive = job.status === 'queued' || job.status === 'processing';
      row.innerHTML = `
        <div class="job-row-top">
          <div class="job-dot" style="background:${job.projectColor || '#6366f1'}"></div>
          <span class="job-title" title="${escapeHtml(job.title || job.filename)}">${escapeHtml(job.title || job.filename)}</span>
          <span class="job-status ${job.status === 'error' ? 'error' : job.status === 'done' ? 'done' : ''}">${label}</span>
          ${isActive ? `<button class="job-stop" data-id="${job.id}" title="Stop and remove">Stop</button>` : ''}
          ${(job.status === 'done' || job.status === 'error') ? `<button class="job-dismiss" data-id="${job.id}" title="Dismiss">×</button>` : ''}
        </div>
        <div class="job-progress"><div class="job-progress-fill ${fillClass}" style="width:${pct}%"></div></div>
        ${job.status === 'error' && job.error ? `<div class="job-error-msg">${escapeHtml(job.error)}</div>` : ''}
      `;
      const dismissBtn = row.querySelector('.job-dismiss');
      if (dismissBtn) {
        dismissBtn.addEventListener('click', async () => {
          await chrome.runtime.sendMessage({ type: 'REMOVE_JOB', id: job.id });
          refreshQueue();
        });
      }
      const stopBtn = row.querySelector('.job-stop');
      if (stopBtn) {
        stopBtn.addEventListener('click', async () => {
          stopBtn.disabled = true;
          stopBtn.textContent = '...';
          const response = await chrome.runtime.sendMessage({ type: 'STOP_JOB', id: job.id });
          if (response?.success && response.wasActive) {
            setStatus(
              response.dataDeleted
                ? `Stopped "${job.title || job.filename}" and deleted its data from Cognee.`
                : `Stopped "${job.title || job.filename}" — could not confirm its data was removed from Cognee.`,
              response.dataDeleted ? 'success' : 'error'
            );
          }
          refreshQueue();
        });
      }
      list.appendChild(row);
    });
  }

  const activeCount = (jobs || []).filter(j => j.status === 'queued' || j.status === 'processing').length;
  if (activeCount > 0) {
    badge.textContent = String(activeCount);
    badge.style.display = 'inline-block';
  } else {
    badge.style.display = 'none';
  }
}

async function refreshQueue() {
  const response = await chrome.runtime.sendMessage({ type: 'GET_QUEUE' });
  if (response?.success) {
    renderQueue(response.jobs);
  }
}

function startQueuePolling() {
  if (queuePollTimer) return;
  refreshQueue();
  queuePollTimer = setInterval(refreshQueue, 2000);
}

function switchTab(tab) {
  const isCognify = tab === 'cognify';
  document.getElementById('tabCognify').style.display = isCognify ? 'flex' : 'none';
  document.getElementById('tabQueue').style.display = isCognify ? 'none' : 'flex';
  document.getElementById('tabBtnCognify').classList.toggle('active', isCognify);
  document.getElementById('tabBtnQueue').classList.toggle('active', !isCognify);
}

// Event listeners
document.getElementById('settingsBtn').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById('addProjectBtn').addEventListener('click', () => {
  const form = document.getElementById('addProjectForm');
  form.style.display = form.style.display === 'none' ? 'block' : 'none';
  if (form.style.display === 'block') {
    document.getElementById('newProjectInput').focus();
    document.getElementById('newSlugInput').value = '';
  }
});

document.getElementById('newProjectInput').addEventListener('input', (e) => {
  const slugInput = document.getElementById('newSlugInput');
  slugInput.value = slugify(e.target.value);
});

document.getElementById('newProjectInput').addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    const slugInput = document.getElementById('newSlugInput');
    await addProject(e.target.value, slugInput.value);
    e.target.value = '';
    slugInput.value = '';
    document.getElementById('addProjectForm').style.display = 'none';
  } else if (e.key === 'Escape') {
    document.getElementById('newProjectInput').value = '';
    document.getElementById('newSlugInput').value = '';
    document.getElementById('addProjectForm').style.display = 'none';
  }
});

document.getElementById('confirmAddBtn').addEventListener('click', async () => {
  const nameInput = document.getElementById('newProjectInput');
  const slugInput = document.getElementById('newSlugInput');
  await addProject(nameInput.value, slugInput.value);
  nameInput.value = '';
  slugInput.value = '';
  document.getElementById('addProjectForm').style.display = 'none';
});

document.getElementById('cancelAddBtn').addEventListener('click', () => {
  document.getElementById('newProjectInput').value = '';
  document.getElementById('newSlugInput').value = '';
  document.getElementById('addProjectForm').style.display = 'none';
});

document.getElementById('cognifyBtn').addEventListener('click', enqueueActiveTab);

document.getElementById('tabBtnCognify').addEventListener('click', () => switchTab('cognify'));
document.getElementById('tabBtnQueue').addEventListener('click', () => switchTab('queue'));

// Init
loadState();
startQueuePolling();
