const DEFAULT_BASE_URL = 'https://api.cognee.ai';

async function load() {
  const data = await chrome.storage.local.get(['cogneeApiKey', 'cogneeBaseUrl']);
  document.getElementById('apiKey').value = data.cogneeApiKey || '';
  document.getElementById('baseUrl').value = data.cogneeBaseUrl || DEFAULT_BASE_URL;
}

function setStatus(msg, type = '') {
  const el = document.getElementById('status');
  el.textContent = msg;
  el.className = 'status ' + type;
}

document.getElementById('toggleKey').addEventListener('click', () => {
  const input = document.getElementById('apiKey');
  input.type = input.type === 'password' ? 'text' : 'password';
});

document.getElementById('saveBtn').addEventListener('click', async () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const baseUrl = document.getElementById('baseUrl').value.trim() || DEFAULT_BASE_URL;

  if (!apiKey) {
    setStatus('API key cannot be empty.', 'error');
    return;
  }

  await chrome.storage.local.set({ cogneeApiKey: apiKey, cogneeBaseUrl: baseUrl });
  setStatus('Settings saved.', 'success');
  setTimeout(() => setStatus(''), 2500);
});

document.getElementById('testBtn').addEventListener('click', async () => {
  const apiKey = document.getElementById('apiKey').value.trim();
  const baseUrl = document.getElementById('baseUrl').value.trim() || DEFAULT_BASE_URL;

  if (!apiKey) {
    setStatus('Enter an API key first.', 'error');
    return;
  }

  setStatus('Testing connection...', 'loading');
  document.getElementById('testBtn').disabled = true;

  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/v1/datasets`, {
      headers: { 'X-Api-Key': apiKey }
    });

    if (res.ok) {
      const data = await res.json();
      const count = Array.isArray(data) ? data.length : '?';
      setStatus(`✓ Connected — ${count} dataset(s) found.`, 'success');
    } else {
      const err = await res.json().catch(() => ({}));
      setStatus(`✗ ${err.detail || err.message || `HTTP ${res.status}`}`, 'error');
    }
  } catch (e) {
    setStatus(`✗ ${e.message}`, 'error');
  } finally {
    document.getElementById('testBtn').disabled = false;
  }
});

load();
