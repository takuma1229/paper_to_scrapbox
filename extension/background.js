const DEFAULT_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

const JOB_STORAGE_KEY = "paper_summary_current_job";
const LOG_LIMIT = 200;

let currentJob = null;
const promptCache = {};
const promptPromises = {};

loadPersistedJob();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "start-summary") {
    const payload = message.payload || {};
    const { pageUrl, project, scrapboxBase, model, apiKey } = payload;
    if (!pageUrl || !project || !scrapboxBase || !model || !apiKey) {
      sendResponse({ ok: false, error: "必須項目が不足しています" });
      return;
    }

    if (currentJob && currentJob.status === "running") {
      sendResponse({ ok: false, error: "別の処理が進行中です" });
      return;
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
      context: {
        pageUrl,
        pdfUrl: payload.pdfUrl || null,
        project,
        scrapboxBase,
        model,
        apiKey
      }
    };

    (async () => {
      try {
        await commitJob();
        await pushLog(jobId, "処理を開始しました");
        await runSummaryFlow({ ...payload }, jobId);
      } catch (err) {
        const messageText = err instanceof Error ? err.message : String(err);
        console.error("Unexpected failure while running summary flow", err);
        await pushLog(jobId, `エラー: ${messageText}`);
        await markJobStatus(jobId, "error", { error: messageText });
      }
    })();

    sendResponse({ ok: true });
    return;
  }

  if (message.type === "get-status") {
    sendResponse({ ok: true, job: currentJob });
    return;
  }

  if (message.type === "clear-status") {
    currentJob = null;
    chrome.storage.local.remove(JOB_STORAGE_KEY).finally(() => {
      broadcastJobUpdate();
    });
    sendResponse({ ok: true });
    return;
  }
});

async function runSummaryFlow(options, jobId) {
  try {
    const {
      pageUrl,
      pdfUrl,
      project,
      scrapboxBase,
      model,
      apiKey
    } = options;

    let resolvedPdfUrl = null;
    if (pdfUrl && pdfUrl.trim()) {
      try {
        resolvedPdfUrl = new URL(pdfUrl, pageUrl).toString();
      } catch (err) {
        throw new Error("指定されたPDF URLを正しく解釈できませんでした");
      }
      await pushLog(jobId, `指定されたPDF URLを使用します: ${resolvedPdfUrl}`);
    } else {
      if (looksLikePdf(pageUrl)) {
        resolvedPdfUrl = pageUrl;
        await pushLog(jobId, "ページURL自体がPDFのため、そのまま使用します");
      } else {
        await pushLog(jobId, "PDFリンクを解析しています...");
        resolvedPdfUrl = await findPdfUrl(jobId, pageUrl);
        await pushLog(jobId, `PDF URLを推定しました: ${resolvedPdfUrl}`);
      }
    }

    const { file, bufferLength } = await downloadPdf(resolvedPdfUrl, pageUrl);
    await pushLog(jobId, `PDFダウンロード完了 (${(bufferLength / 1024).toFixed(1)} KB)`);

    const uploadResult = await uploadFileToOpenAI(file, apiKey);
    const uploadedFileId = uploadResult && uploadResult.id;
    if (!uploadedFileId) {
      throw new Error("OpenAIがファイルIDを返しませんでした");
    }
    await pushLog(jobId, "OpenAIへファイルをアップロードしました");

    let title;
    let summary;
    try {
      await pushLog(jobId, "タイトルを抽出しています...");
      title = await requestTitle(uploadedFileId, model, apiKey);
      if (!title) {
        throw new Error("タイトルを取得できませんでした");
      }
      await pushLog(jobId, `タイトルを取得しました: ${title}`);

      await pushLog(jobId, "要約を生成しています...");
      summary = await requestSummaryText(uploadedFileId, model, apiKey);
      if (!summary) {
        throw new Error("要約を取得できませんでした");
      }
      await pushLog(jobId, `要約を取得しました (文字数: ${summary.length})`);
    } finally {
      await deleteUploadedFile(uploadedFileId, apiKey);
      await pushLog(jobId, "OpenAIの一時ファイルを削除しました");
    }

    const scrapboxUrl = buildScrapboxUrl(scrapboxBase, project, title, summary);
    await pushLog(jobId, "Scrapboxページを開きます...");
    await openScrapboxTab(scrapboxUrl);
    await pushLog(jobId, "処理が完了しました");

    await markJobStatus(jobId, "success", {
      result: {
        title,
        summaryLength: summary.length,
        scrapboxUrl
      }
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error("Summary flow failed", error);
    await pushLog(jobId, `エラー: ${message}`);
    await markJobStatus(jobId, "error", { error: message });
  }
}

async function loadPersistedJob() {
  try {
    const stored = await chrome.storage.local.get(JOB_STORAGE_KEY);
    const job = stored[JOB_STORAGE_KEY] || null;
    if (job) {
      currentJob = job;
      if (job.status === "running") {
        ensureJobLogs();
        if (job.context && job.context.apiKey) {
          currentJob.logs.push({
            timestamp: new Date().toISOString(),
            message: "サービスワーカー再起動のため処理を再開します"
          });
          await commitJob();
          (async () => {
            try {
              await runSummaryFlow({ ...currentJob.context }, currentJob.id);
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              await pushLog(currentJob.id, `エラー: ${message}`);
              await markJobStatus(currentJob.id, "error", { error: message });
            }
          })();
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
    }
  } catch (err) {
    console.error("ジョブ状態の復元に失敗しました", err);
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
    // ignore when no listeners are active
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
    currentJob.context.apiKey = null;
  }
  await commitJob();
}

async function findPdfUrl(jobId, pageUrl) {
  const direct = deriveDirectPdfUrl(pageUrl);
  if (direct) {
    await pushLog(jobId, `既知パターンからPDFを推定: ${direct}`);
    return direct;
  }

  const response = await fetch(pageUrl, {
    method: "GET",
    headers: DEFAULT_HEADERS,
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`ページ取得に失敗しました (status ${response.status})`);
  }
  const html = await response.text();
  const pdfCandidates = [];

  const anchorRegex = /<a\b[^>]*href\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))[^>]*>(.*?)<\/a>/gis;
  for (const match of html.matchAll(anchorRegex)) {
    const href = match[2] || match[3] || match[4] || "";
    const rawAnchor = match[0] || "";
    const anchorText = stripTags(match[5] || "");
    const typeAttr = (extractAttribute(rawAnchor, "type") || "").toLowerCase();
    if (!href) {
      continue;
    }
    let resolved;
    try {
      resolved = new URL(href, pageUrl).toString();
    } catch (err) {
      continue;
    }
    if (looksLikePdf(resolved, anchorText, typeAttr)) {
      if (resolved.toLowerCase().endsWith(".pdf")) {
        return resolved;
      }
      uniquePush(pdfCandidates, resolved);
    }
  }

  const metaRegex = /<meta\b[^>]*name\s*=\s*("citation_pdf_url"|'citation_pdf_url')[^>]*>/gi;
  for (const metaMatch of html.matchAll(metaRegex)) {
    const tag = metaMatch[0];
    const content = extractAttribute(tag, "content");
    if (!content) {
      continue;
    }
    try {
      const resolved = new URL(content, pageUrl).toString();
      if (resolved.toLowerCase().endsWith(".pdf")) {
        return resolved;
      }
      uniquePush(pdfCandidates, resolved);
    } catch (err) {
      // ignore invalid URL
    }
  }

  const linkRegex = /<link\b[^>]*>/gi;
  for (const linkMatch of html.matchAll(linkRegex)) {
    const tag = linkMatch[0];
    const typeAttr = (extractAttribute(tag, "type") || "").toLowerCase();
    if (typeAttr !== "application/pdf") {
      continue;
    }
    const href = extractAttribute(tag, "href");
    if (!href) {
      continue;
    }
    try {
      const resolved = new URL(href, pageUrl).toString();
      if (resolved.toLowerCase().endsWith(".pdf")) {
        return resolved;
      }
      uniquePush(pdfCandidates, resolved);
    } catch (err) {
      // ignore invalid URL
    }
  }

  if (pdfCandidates.length > 0) {
    return pdfCandidates[0];
  }

  throw new Error("PDFリンクを検出できませんでした");
}

function extractAttribute(tag, name) {
  const regex = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
  const match = tag.match(regex);
  if (!match) {
    return "";
  }
  return match[2] || match[3] || match[4] || "";
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function deriveDirectPdfUrl(pageUrl) {
  let parsed;
  try {
    parsed = new URL(pageUrl);
  } catch (err) {
    return null;
  }
  const host = (parsed.hostname || "").toLowerCase();
  const path = parsed.pathname || "";

  if (host.endsWith("arxiv.org") && path.startsWith("/abs/")) {
    const identifier = path.replace(/^\/abs\//, "").replace(/\/$/, "");
    if (identifier) {
      const suffix = identifier.endsWith(".pdf") ? "" : ".pdf";
      return `${parsed.origin}/pdf/${identifier}${suffix}`;
    }
  }

  if (host.endsWith("aclanthology.org")) {
    const normalized = path.replace(/\/$/, "");
    if (normalized) {
      return `${parsed.origin}${normalized}.pdf`;
    }
  }

  if (host.endsWith("openreview.net")) {
    const id = parsed.searchParams.get("id");
    if (id) {
      return `${parsed.origin}/pdf?id=${id}`;
    }
  }

  if (host === "dl.acm.org" && path.includes("/doi/")) {
    const doiPart = path.split("/doi/").pop();
    if (doiPart) {
      return `${parsed.origin}/doi/pdf/${doiPart}?download=true`;
    }
  }

  return null;
}

function looksLikePdf(url, anchorText = "", mimeType = "") {
  const lowerUrl = url.toLowerCase();
  const lowerText = (anchorText || "").toLowerCase();
  const lowerMime = (mimeType || "").toLowerCase();
  if (lowerUrl.endsWith(".pdf")) {
    return true;
  }
  if (lowerMime === "application/pdf") {
    return true;
  }
  if (lowerUrl.includes(".pdf")) {
    return true;
  }
  if (lowerUrl.includes("/pdf/")) {
    return true;
  }
  if (lowerUrl.includes("format=pdf") || lowerUrl.includes("download=1")) {
    return true;
  }
  if (lowerText.includes("pdf")) {
    return true;
  }
  return false;
}

function uniquePush(list, value) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

async function downloadPdf(pdfUrl, referer) {
  const response = await fetch(pdfUrl, {
    method: "GET",
    credentials: "include",
    headers: referer
      ? {
          ...DEFAULT_HEADERS,
          Referer: referer
        }
      : DEFAULT_HEADERS
  });
  if (!response.ok) {
    throw new Error(`PDFダウンロードに失敗しました (status ${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength === 0) {
    throw new Error("PDFデータが空でした");
  }
  const filename = inferFilenameFromUrl(pdfUrl);
  const file = new File([buffer], filename, { type: "application/pdf" });
  return { file, bufferLength: buffer.byteLength };
}

function inferFilenameFromUrl(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split("/").filter(Boolean);
    if (segments.length > 0) {
      return segments[segments.length - 1] || "paper.pdf";
    }
  } catch (err) {
    // ignore
  }
  return "paper.pdf";
}

async function uploadFileToOpenAI(file, apiKey) {
  const formData = new FormData();
  formData.append("purpose", "assistants");
  formData.append("file", file, file.name);

  const response = await fetch("https://api.openai.com/v1/files", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`
    },
    body: formData
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`ファイルアップロード失敗: ${response.status} ${text}`);
  }
  return response.json();
}

async function requestTitle(uploadedFileId, model, apiKey) {
  const prompt = await loadPromptFile("title_prompt.txt");
  const titleText = await requestTextFromOpenAI(uploadedFileId, model, apiKey, prompt, "タイトル抽出");
  return titleText.split(/\r?\n/)[0].trim();
}

async function requestSummaryText(uploadedFileId, model, apiKey) {
  const prompt = await loadPromptFile("summarization_prompt.txt");
  const rawText = await requestTextFromOpenAI(uploadedFileId, model, apiKey, prompt, "要約生成");
  let summary = rawText.trim();
  if (summary.startsWith("{")) {
    try {
      const parsed = JSON.parse(summary);
      const summaryField = (parsed.summary || "").trim();
      if (summaryField) {
        summary = summaryField;
      }
    } catch (err) {
      console.warn("要約レスポンスのJSON解析に失敗しました", err);
    }
  }
  return summary;
}

async function requestTextFromOpenAI(uploadedFileId, model, apiKey, userPrompt, description) {
  const systemPrompt = "あなたは日本語で簡潔かつ正確に情報を伝える研究支援アシスタントです。指示された形式を厳守してください。";

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "system",
          content: [{ type: "input_text", text: systemPrompt }]
        },
        {
          role: "user",
          content: [
            { type: "input_text", text: userPrompt },
            { type: "input_file", file_id: uploadedFileId }
          ]
        }
      ],
    })
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${description}リクエスト失敗: ${response.status} ${text}`);
  }
  const responseObject = await response.json();
  const text = extractTextFromResponse(responseObject).trim();
  if (!text) {
    throw new Error(`${description}の結果が空でした`);
  }
  return text;
}

function extractTextFromResponse(responseObject) {
  const chunks = [];
  if (responseObject && Array.isArray(responseObject.output)) {
    for (const item of responseObject.output) {
      if (!item || !Array.isArray(item.content)) {
        continue;
      }
      for (const content of item.content) {
        if (content && content.type === "output_text" && content.text) {
          chunks.push(content.text);
        }
      }
    }
  }
  if (chunks.length === 0 && responseObject && responseObject.output_text) {
    chunks.push(responseObject.output_text);
  }
  return chunks.map((chunk) => chunk.trim()).filter(Boolean).join("\n").trim();
}

async function deleteUploadedFile(fileId, apiKey) {
  try {
    await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
  } catch (err) {
    console.warn("OpenAIファイル削除に失敗しました", err);
  }
}

function sanitizeBaseUrl(value) {
  return value.replace(/\/$/, "");
}

function buildScrapboxUrl(baseUrl, project, title, summary) {
  const trimmedBase = sanitizeBaseUrl(baseUrl);
  const encodedProject = encodeURIComponent(project);
  const encodedTitle = encodeURIComponent(title);
  const bodyText = (summary || "").trim();
  const encodedBody = encodeURIComponent(bodyText);
  return `${trimmedBase}/${encodedProject}/${encodedTitle}?body=${encodedBody}`;
}

async function openScrapboxTab(url) {
  await chrome.tabs.create({ url });
}

async function loadPromptFile(filename) {
  if (promptCache[filename]) {
    return promptCache[filename];
  }
  if (!promptPromises[filename]) {
    promptPromises[filename] = (async () => {
      const url = chrome.runtime.getURL(filename);
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${filename} の読み込みに失敗しました (status ${response.status})`);
      }
      const text = (await response.text()).trim();
      if (!text) {
        throw new Error(`${filename} が空です`);
      }
      promptCache[filename] = text;
      return text;
    })();
  }
  return promptPromises[filename];
}
