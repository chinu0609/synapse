const DEFAULT_BASE_URL = 'https://api.cognee.ai';
const QUEUE_ALARM = 'synapse-queue-tick';
const IDB_NAME = 'synapse-jobs';
const IDB_STORE = 'payloads';

async function getSettings() {
  const data = await chrome.storage.local.get(['cogneeApiKey', 'cogneeBaseUrl']);
  return {
    apiKey: data.cogneeApiKey || '',
    baseUrl: (data.cogneeBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, '')
  };
}

async function cogneeRequest(path, method, body, apiKey, baseUrl, retries = 0) {
  const url = `${baseUrl}${path}`;

  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey
      },
      body: body ? JSON.stringify(body) : undefined
    });

    // cognee's embedded graph DB briefly holds a per-dataset file lock
    // (e.g. while the dashboard has that dataset's graph open) — a 500
    // here is often that transient lock, not a real failure, so retry.
    if (res.status === 500 && attempt < retries) {
      await new Promise(r => setTimeout(r, 700 * (attempt + 1)));
      continue;
    }

    return handleCogneeResponse(res);
  }
}

async function cogneeFormRequest(path, formData, apiKey, baseUrl) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'X-Api-Key': apiKey
    },
    body: formData
  });

  return handleCogneeResponse(res);
}

async function handleCogneeResponse(res) {
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const json = await res.json();
      msg = json.detail || json.message || json.error || msg;
    } catch {}
    throw new Error(msg);
  }

  try {
    return await res.json();
  } catch {
    return { ok: true };
  }
}

async function handleTestConnection() {
  const { apiKey, baseUrl } = await getSettings();
  if (!apiKey) throw new Error('No API key configured.');
  const result = await cogneeRequest('/api/v1/datasets', 'GET', null, apiKey, baseUrl);
  return { success: true, datasets: result };
}

async function deleteDatasetByName(datasetName) {
  const { apiKey, baseUrl } = await getSettings();
  if (!apiKey) throw new Error('No API key configured.');

  const list = await cogneeRequest('/api/v1/datasets', 'GET', null, apiKey, baseUrl);
  const match = Array.isArray(list) ? list.find(d => d.name === datasetName) : null;
  if (!match) return { success: true, skipped: true };

  await cogneeRequest(`/api/v1/datasets/${match.id}`, 'DELETE', null, apiKey, baseUrl, 2);
  return { success: true };
}

async function datasetExists(datasetName) {
  const { apiKey, baseUrl } = await getSettings();
  if (!apiKey) throw new Error('No API key configured.');

  const list = await cogneeRequest('/api/v1/datasets', 'GET', null, apiKey, baseUrl);
  const exists = Array.isArray(list) && list.some(d => d.name === datasetName);
  return { success: true, exists };
}

// --- IndexedDB: holds raw job payload bytes (too large/binary for chrome.storage.local) ---

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(IDB_STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function putPayload(id, blob) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(blob, id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function getPayload(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function deletePayload(id) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function base64ToBlob(base64, mime) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

// --- Job queue ---

async function getJobsAndState() {
  const data = await chrome.storage.local.get(['jobs', 'queueState']);
  return {
    jobs: data.jobs || [],
    queueState: data.queueState || { activeJobId: null }
  };
}

function withUniqueFilename(filename, id) {
  const dot = filename.lastIndexOf('.');
  if (dot === -1) return `${filename}-${id}`;
  return `${filename.slice(0, dot)}-${id}${filename.slice(dot)}`;
}

async function saveJobs(jobs, queueState) {
  await chrome.storage.local.set({ jobs, queueState });
}

async function enqueueJob({ title, datasetName, projectName, projectColor, kind, filename, mime, dataBase64, url }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const blob = base64ToBlob(dataBase64, mime);
  await putPayload(id, blob);

  // Unique filename so a stopped/cancelled job's exact data item can be
  // found and deleted from cognee without touching other jobs' data in
  // the same (per-project) dataset.
  const uniqueFilename = withUniqueFilename(filename, id);

  const { jobs, queueState } = await getJobsAndState();
  jobs.push({
    id,
    title: title || filename,
    datasetName,
    projectName,
    projectColor,
    kind,
    filename: uniqueFilename,
    url: url || '',
    status: 'queued',
    stage: 'queued',
    datasetId: null,
    error: null,
    createdAt: Date.now()
  });
  await saveJobs(jobs, queueState);

  await ensureAlarm();
  await tickQueue();
  return { success: true, id };
}

async function removeJob(id) {
  const { jobs, queueState } = await getJobsAndState();
  const remaining = jobs.filter(j => j.id !== id);
  await saveJobs(remaining, queueState);
  try {
    await deletePayload(id);
  } catch {}
  return { success: true };
}

async function stopJob(id) {
  const { apiKey, baseUrl } = await getSettings();
  let { jobs, queueState } = await getJobsAndState();
  const job = jobs.find(j => j.id === id);
  if (!job) return { success: true };

  let dataDeleted = false;
  let deleteError = null;

  // A queued job never touched the server — nothing to clean up there.
  // A processing job already has a Data record in the (per-project) dataset,
  // so find that exact item by its unique filename and delete only that,
  // not the whole dataset (which may hold other pages already cognified).
  if (job.status === 'processing' && job.datasetId && apiKey) {
    try {
      const dataList = await cogneeRequest(
        `/api/v1/datasets/${job.datasetId}/data`,
        'GET',
        null,
        apiKey,
        baseUrl
      );
      const match = Array.isArray(dataList) ? dataList.find(d => d.name === job.filename) : null;
      if (match) {
        await cogneeRequest(
          `/api/v1/datasets/${job.datasetId}/data/${match.id}`,
          'DELETE',
          null,
          apiKey,
          baseUrl,
          2
        );
        dataDeleted = true;
      }
    } catch (err) {
      deleteError = err.message;
    }
  }

  const wasActive = job.status === 'processing';

  ({ jobs, queueState } = await getJobsAndState());
  if (queueState.activeJobId === id) queueState.activeJobId = null;
  const remaining = jobs.filter(j => j.id !== id);
  await saveJobs(remaining, queueState);

  try {
    await deletePayload(id);
  } catch {}

  await tickQueue();

  return { success: true, wasActive, dataDeleted, deleteError };
}

const STAGE_PIPELINE_STATUS = {
  DATASET_PROCESSING_INITIATED: 'initiated',
  DATASET_PROCESSING_STARTED: 'started',
  DATASET_PROCESSING_COMPLETED: 'completed',
  DATASET_PROCESSING_ERRORED: 'errored'
};

async function tickQueue() {
  const { apiKey, baseUrl } = await getSettings();
  if (!apiKey) return;

  let { jobs, queueState } = await getJobsAndState();

  if (queueState.activeJobId) {
    const job = jobs.find(j => j.id === queueState.activeJobId);
    if (!job || job.status !== 'processing') {
      queueState.activeJobId = null;
    } else {
      try {
        const statusMap = await cogneeRequest(
          `/api/v1/datasets/status?dataset=${job.datasetId}`,
          'GET',
          null,
          apiKey,
          baseUrl
        );
        const rawStatus = statusMap[job.datasetId];
        const stage = STAGE_PIPELINE_STATUS[rawStatus] || job.stage;
        job.stage = stage;

        if (stage === 'completed') {
          job.status = 'done';
          queueState.activeJobId = null;
        } else if (stage === 'errored') {
          job.status = 'error';
          job.error = job.error || 'Cognee pipeline reported an error.';
          queueState.activeJobId = null;
        }
        await saveJobs(jobs, queueState);
      } catch (err) {
        // Transient poll failure — leave job in place, try again on next tick.
      }
    }
  }

  if (!queueState.activeJobId) {
    ({ jobs, queueState } = await getJobsAndState());
    const next = jobs.find(j => j.status === 'queued');
    if (next) {
      await startJob(next, apiKey, baseUrl);
      // A failed start doesn't set activeJobId, so try the next one immediately.
      ({ jobs, queueState } = await getJobsAndState());
      if (!queueState.activeJobId && jobs.some(j => j.status === 'queued')) {
        await tickQueue();
      }
    }
  }
}

async function startJob(job, apiKey, baseUrl) {
  let { jobs, queueState } = await getJobsAndState();
  const target = jobs.find(j => j.id === job.id);
  if (!target) return;

  target.stage = 'uploading';
  await saveJobs(jobs, queueState);

  try {
    const blob = await getPayload(job.id);
    if (!blob) throw new Error('Job payload missing (extension may have been reloaded).');

    const formData = new FormData();
    formData.append('data', blob, job.filename);
    formData.append('datasetName', job.datasetName);
    formData.append('run_in_background', 'true');

    const result = await cogneeFormRequest('/api/v1/remember', formData, apiKey, baseUrl);

    ({ jobs, queueState } = await getJobsAndState());
    const updated = jobs.find(j => j.id === job.id);
    if (updated) {
      updated.status = 'processing';
      updated.stage = 'initiated';
      updated.datasetId = result.dataset_id || result.datasetId;
      queueState.activeJobId = updated.id;
      await saveJobs(jobs, queueState);
    }

    await deletePayload(job.id).catch(() => {});
  } catch (err) {
    ({ jobs, queueState } = await getJobsAndState());
    const failed = jobs.find(j => j.id === job.id);
    if (failed) {
      failed.status = 'error';
      failed.stage = 'errored';
      failed.error = err.message;
      await saveJobs(jobs, queueState);
    }
    await deletePayload(job.id).catch(() => {});
  }
}

async function ensureAlarm() {
  const alarm = await chrome.alarms.get(QUEUE_ALARM);
  if (!alarm) {
    chrome.alarms.create(QUEUE_ALARM, { periodInMinutes: 1 });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true })
    .catch((error) => console.error(error));
});

chrome.runtime.onStartup.addListener(ensureAlarm);

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_ALARM) {
    tickQueue();
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'ENQUEUE_JOB') {
    enqueueJob(msg)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_QUEUE') {
    tickQueue()
      .catch(() => {})
      .then(() => getJobsAndState())
      .then(({ jobs }) => sendResponse({ success: true, jobs }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'REMOVE_JOB') {
    removeJob(msg.id)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'STOP_JOB') {
    stopJob(msg.id)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'DELETE_DATASET') {
    deleteDatasetByName(msg.datasetName)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'DATASET_EXISTS') {
    datasetExists(msg.datasetName)
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'TEST_CONNECTION') {
    handleTestConnection()
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
