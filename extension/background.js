const JOB_STORAGE_KEY = "paper_summary_current_job";
const LOG_LIMIT = 200;
const DEFAULT_CANCEL_MESSAGE = "ユーザーが処理を中断しました";

let currentJob = null;

loadPersistedJob();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "start-summary") {
    handleStartMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("Failed to start summary job", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (message.type === "get-status") {
    sendResponse({ ok: true, job: currentJob });
    return;
  }

  if (message.type === "cancel-summary") {
    handleCancelMessage()
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("Failed to cancel summary job", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (message.type === "clear-status") {
    currentJob = null;
    chrome.storage.local.remove(JOB_STORAGE_KEY).finally(() => {
      broadcastJobUpdate();
    });
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "offscreen-log") {
    handleOffscreenLog(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Failed to handle offscreen log", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (message.type === "offscreen-result") {
    handleOffscreenResult(message)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => {
        console.error("Failed to handle offscreen result", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }
});

async function handleStartMessage(message) {
  const payload = message.payload || {};
  const { pageUrl, project, scrapboxBase, model, apiKey } = payload;
  if (!pageUrl || !project || !scrapboxBase || !model || !apiKey) {
    return { ok: false, error: "必須項目が不足しています" };
  }

  if (currentJob && currentJob.status === "running") {
    return { ok: false, error: "別の処理が進行中です" };
  }

  const jobId = crypto.randomUUID();
  currentJob = {
    id: jobId,
    status: "running",
    logs: [],
    startedAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    error: null,
    result: null,
    cancelRequested: false,
    cancelReason: null,
    context: {
      pageUrl,
      pdfUrl: payload.pdfUrl || null,
      project,
      scrapboxBase,
      model,
      apiKey
    }
  };

  await commitJob();
  await pushLog(jobId, "処理を開始しました");

  try {
    await ensureOffscreenDocument();
    const response = await sendToOffscreen({
      type: "offscreen-start",
      jobId,
      context: currentJob.context
    });
    if (!response || !response.ok) {
      throw new Error(response?.error || "オフスクリーン文書に処理を依頼できませんでした");
    }
    return { ok: true };
  } catch (error) {
    const messageText = error instanceof Error ? error.message : String(error);
    await pushLog(jobId, `エラー: ${messageText}`);
    await markJobStatus(jobId, "error", { error: messageText });
    throw error;
  }
}

async function handleCancelMessage() {
  if (!currentJob || currentJob.status !== "running") {
    return { ok: false, error: "進行中の処理はありません" };
  }
  if (currentJob.cancelRequested) {
    return { ok: false, error: "既に中断要求を受け付けています" };
  }
  currentJob.cancelRequested = true;
  currentJob.cancelReason = DEFAULT_CANCEL_MESSAGE;
  await commitJob();
  await pushLog(currentJob.id, "ユーザーが処理の中断を要求しました");
  try {
    await sendToOffscreen({ type: "offscreen-cancel", jobId: currentJob.id });
  } catch (error) {
    console.warn("Failed to notify offscreen worker about cancellation", error);
  }
  return { ok: true };
}

async function handleOffscreenLog(message) {
  if (!currentJob || currentJob.id !== message.jobId) {
    return;
  }
  await pushLog(message.jobId, message.message || "");
}

async function handleOffscreenResult(message) {
  const { jobId, status, payload = {} } = message;
  if (!currentJob || currentJob.id !== jobId) {
    return;
  }

  if (status === "success") {
    if (payload.scrapboxUrl) {
      try {
        await openScrapboxTab(payload.scrapboxUrl);
      } catch (err) {
        console.error("Failed to open Scrapbox tab", err);
        await pushLog(jobId, "Scrapboxタブの起動に失敗しました");
      }
    }
    await markJobStatus(jobId, "success", {
      result: {
        title: payload.title,
        summaryLength: payload.summaryLength,
        scrapboxUrl: payload.scrapboxUrl
      }
    });
    return;
  }

  const errorMessage = payload.error || DEFAULT_CANCEL_MESSAGE;

  if (status === "aborted") {
    currentJob.cancelRequested = true;
    currentJob.cancelReason = errorMessage;
    await markJobStatus(jobId, "aborted", { error: errorMessage });
    return;
  }

  await markJobStatus(jobId, "error", { error: errorMessage });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen || !chrome.offscreen.createDocument) {
    throw new Error("offscreen API を利用できません");
  }
  if (chrome.offscreen.hasDocument) {
    const hasDocument = await chrome.offscreen.hasDocument();
    if (hasDocument) {
      return;
    }
  }
  await chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["WORKERS"],
    justification: "長時間の要約処理をバックグラウンドで継続するため"
  });
}

function sendToOffscreen(message) {
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

async function loadPersistedJob() {
  try {
    const stored = await chrome.storage.local.get(JOB_STORAGE_KEY);
    const job = stored[JOB_STORAGE_KEY] || null;
    if (!job) {
      return;
    }
    currentJob = job;
    ensureJobLogs();

    if (job.status === "running") {
      if (job.context && job.context.apiKey) {
        currentJob.cancelRequested = false;
        currentJob.cancelReason = null;
        currentJob.logs.push({
          timestamp: new Date().toISOString(),
          message: "サービスワーカーが再起動しましたが処理は継続中です"
        });
        await commitJob();
        try {
          await ensureOffscreenDocument();
          await sendToOffscreen({
            type: "offscreen-start",
            jobId: currentJob.id,
            context: currentJob.context,
            resume: true
          });
        } catch (error) {
          const messageText = error instanceof Error ? error.message : String(error);
          await pushLog(currentJob.id, `エラー: ${messageText}`);
          await markJobStatus(currentJob.id, "error", { error: messageText });
        }
      } else {
        currentJob.status = "aborted";
        currentJob.error = "サービスワーカー再起動時に再開に必要な情報が不足していました。もう一度実行してください。";
        currentJob.logs.push({
          timestamp: new Date().toISOString(),
          message: currentJob.error
        });
        await commitJob();
      }
    } else {
      broadcastJobUpdate();
    }
  } catch (error) {
    console.error("ジョブ状態の復元に失敗しました", error);
  }
}

function ensureJobLogs() {
  if (currentJob && !Array.isArray(currentJob.logs)) {
    currentJob.logs = [];
  }
}

async function commitJob() {
  if (currentJob) {
    currentJob.updatedAt = Date.now();
    await chrome.storage.local.set({ [JOB_STORAGE_KEY]: currentJob });
  } else {
    await chrome.storage.local.remove(JOB_STORAGE_KEY);
  }
  broadcastJobUpdate();
}

function broadcastJobUpdate() {
  try {
    chrome.runtime.sendMessage({ type: "job-update", job: currentJob }).catch(() => {});
  } catch (err) {
    // listener が存在しない場合は無視
  }
}

async function pushLog(jobId, message) {
  if (!currentJob || currentJob.id !== jobId) {
    return;
  }
  ensureJobLogs();
  currentJob.logs.push({ timestamp: new Date().toISOString(), message });
  if (currentJob.logs.length > LOG_LIMIT) {
    currentJob.logs.shift();
  }
  await commitJob();
}

async function markJobStatus(jobId, status, extra = {}) {
  if (!currentJob || currentJob.id !== jobId) {
    return;
  }
  currentJob.status = status;
  currentJob.finishedAt = Date.now();
  currentJob.error = extra.error || null;
  if (extra.result !== undefined) {
    currentJob.result = extra.result;
  } else if (status !== "success") {
    currentJob.result = null;
  }
  if (status !== "running" && currentJob.context) {
    if (status !== "running") {
      currentJob.context.apiKey = null;
    }
  }
  if (status !== "running") {
    currentJob.cancelRequested = false;
    currentJob.cancelReason = null;
  }
  await commitJob();
}

async function openScrapboxTab(url) {
  if (!url) {
    return;
  }
  await chrome.tabs.create({ url });
}
