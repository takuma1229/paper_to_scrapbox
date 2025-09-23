const statusEl = document.getElementById("status");
const formEl = document.getElementById("summary-form");
const inputPageUrl = document.getElementById("page-url");
const inputPdfUrl = document.getElementById("pdf-url");
const inputProject = document.getElementById("project");
const inputScrapboxBase = document.getElementById("scrapbox-base");
const inputApiKey = document.getElementById("api-key");
const inputModel = document.getElementById("model");
const stateEl = document.getElementById("job-state");

let currentJob = null;

function updateState(label, className) {
  stateEl.textContent = label;
  stateEl.className = className;
}

function setFormDisabled(disabled) {
  const elements = formEl.querySelectorAll("input, button, select, textarea");
  elements.forEach((el) => {
    el.disabled = disabled;
  });
}

function formatLog(entry) {
  const timestamp = entry && entry.timestamp ? new Date(entry.timestamp) : new Date();
  const timeLabel = timestamp.toLocaleTimeString();
  return `[${timeLabel}] ${entry && entry.message ? entry.message : ""}`;
}

function renderJob(job) {
  currentJob = job || null;
  const logs = job && Array.isArray(job.logs) ? job.logs : [];
  statusEl.textContent = logs.map(formatLog).join("\n");

  const status = job ? job.status : null;
  if (!job) {
    updateState("準備完了", "state-idle");
    setFormDisabled(false);
    return;
  }

  if (status === "running") {
    updateState("処理中...", "state-running");
    setFormDisabled(true);
  } else if (status === "success") {
    const title = job.result && job.result.title ? `: ${job.result.title}` : "";
    updateState(`完了${title}`, "state-success");
    setFormDisabled(false);
  } else if (status === "error") {
    updateState(`エラー: ${job.error || "詳細不明"}`, "state-error");
    setFormDisabled(false);
  } else if (status === "aborted") {
    updateState(job.error || "前回の処理は中断されました", "state-error");
    setFormDisabled(false);
  } else {
    updateState("準備完了", "state-idle");
    setFormDisabled(false);
  }
}

function prefillCurrentTabUrl() {
  chrome.tabs.query({ active: true, lastFocusedWindow: true }, (tabs) => {
    const maybeError = chrome.runtime.lastError;
    if (maybeError) {
      console.warn("Failed to get current tab", maybeError);
      return;
    }
    if (!tabs || tabs.length === 0) {
      return;
    }
    const tab = tabs[0];
    if (!tab || !tab.url) {
      return;
    }
    try {
      const parsed = new URL(tab.url);
      if (parsed.protocol === "http:" || parsed.protocol === "https:") {
        inputPageUrl.value = tab.url;
      }
    } catch (err) {
      // ignore invalid URLs such as chrome://
    }
  });
}

function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => resolve(items || {}));
  });
}

function storageSet(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve());
  });
}

async function restoreFormValues() {
  const stored = await storageGet([
    "project",
    "scrapboxBase",
    "model",
    "apiKey"
  ]);
  if (stored.project) {
    inputProject.value = stored.project;
  }
  if (stored.scrapboxBase) {
    inputScrapboxBase.value = stored.scrapboxBase;
  }
  if (stored.model) {
    inputModel.value = stored.model;
  }
  if (stored.apiKey) {
    inputApiKey.value = stored.apiKey;
  }
}

async function persistFormValues() {
  await storageSet({
    project: inputProject.value,
    scrapboxBase: inputScrapboxBase.value,
    model: inputModel.value,
    apiKey: inputApiKey.value
  });
}

function sendMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      const maybeError = chrome.runtime.lastError;
      if (maybeError) {
        reject(maybeError);
        return;
      }
      resolve(response);
    });
  });
}

async function requestJobStatus() {
  try {
    const response = await sendMessage({ type: "get-status" });
    if (response && response.ok) {
      renderJob(response.job || null);
    } else {
      renderJob(null);
    }
  } catch (err) {
    console.error("Failed to fetch job status", err);
    renderJob(null);
  }
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  setFormDisabled(true);
  statusEl.textContent = "";
  updateState("処理を開始しています...", "state-running");

  const pageUrl = inputPageUrl.value.trim();
  const pdfUrl = inputPdfUrl.value.trim();
  const project = inputProject.value.trim();
  const scrapboxBase = inputScrapboxBase.value.trim();
  const apiKey = inputApiKey.value.trim();
  const model = inputModel.value.trim();

  if (!pageUrl || !project || !scrapboxBase || !apiKey || !model) {
    renderJob(null);
    statusEl.textContent = "必要な項目が未入力です";
    return;
  }

  try {
    await persistFormValues();
    const response = await sendMessage({
      type: "start-summary",
      payload: {
        pageUrl,
        pdfUrl: pdfUrl || null,
        project,
        scrapboxBase,
        apiKey,
        model
      }
    });

    if (!response || !response.ok) {
      const errorMessage = (response && response.error) || "処理を開始できませんでした";
      statusEl.textContent = errorMessage;
      setFormDisabled(false);
      updateState("エラー", "state-error");
      return;
    }

    // 背景で処理が進むため、状態はジョブ更新イベントで反映される
  } catch (err) {
    console.error("Failed to start summary", err);
    statusEl.textContent = err && err.message ? err.message : String(err);
    updateState("エラー", "state-error");
    setFormDisabled(false);
  }
});

chrome.runtime.onMessage.addListener((message) => {
  if (message && message.type === "job-update") {
    renderJob(message.job || null);
  }
});

updateState("準備完了", "state-idle");

restoreFormValues()
  .catch((err) => {
    console.error("Failed to restore form values", err);
  })
  .finally(() => {
    prefillCurrentTabUrl();
    requestJobStatus();
  });
