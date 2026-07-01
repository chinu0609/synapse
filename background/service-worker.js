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

async function cogneeRequest(path, method, body, apiKey, baseUrl) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-Api-Key': apiKey
    },
    body: body ? JSON.stringify(body) : undefined
  });

  return handleCogneeResponse(res);
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

async function saveJobs(jobs, queueState) {
  await chrome.storage.local.set({ jobs, queueState });
}

async function enqueueJob({ title, datasetName, projectName, projectColor, kind, filename, mime, dataBase64, url }) {
  const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const blob = base64ToBlob(dataBase64, mime);
  await putPayload(id, blob);

  const { jobs, queueState } = await getJobsAndState();
  jobs.push({
    id,
    title: title || filename,
    datasetName,
    projectName,
    projectColor,
    kind,
    filename,
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

chrome.runtime.onInstalled.addListener(ensureAlarm);
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

  if (msg.type === 'TEST_CONNECTION') {
    handleTestConnection()
      .then(sendResponse)
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }
});
