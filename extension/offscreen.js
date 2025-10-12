const DEFAULT_HEADERS = {
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

let currentJob = null;
let cancelRequested = false;
const promptCache = new Map();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    return;
  }

  if (message.type === "offscreen-start") {
    handleStartMessage(message)
      .then((result) => sendResponse(result))
      .catch((error) => {
        console.error("Failed to start offscreen job", error);
        sendResponse({ ok: false, error: error?.message || String(error) });
      });
    return true;
  }

  if (message.type === "offscreen-cancel") {
    if (!currentJob || currentJob.id !== message.jobId) {
      sendResponse({ ok: false, error: "対象のジョブが見つかりません" });
      return;
    }
    cancelRequested = true;
    sendResponse({ ok: true });
    return;
  }

  if (message.type === "offscreen-sync") {
    const status = currentJob
      ? { running: true, jobId: currentJob.id }
      : { running: false };
    sendResponse({ ok: true, status });
    return;
  }
});

async function handleStartMessage(message) {
  const { jobId, context, resume } = message;
  if (!jobId || !context) {
    return { ok: false, error: "ジョブ情報が不足しています" };
  }

  if (currentJob) {
    if (currentJob.id === jobId) {
      if (resume) {
        // 既に実行中。背景側からの再同期なのでOKを返す。
        return { ok: true, resumed: true };
      }
      return { ok: false, error: "同じジョブが実行中です" };
    }
    return { ok: false, error: "別のジョブが実行中です" };
  }

  cancelRequested = false;
  currentJob = { id: jobId, context };

  runSummaryJob(jobId, context)
    .catch((error) => {
      console.error("Offscreen job failed", error);
      notifyResult(jobId, "error", {
        error: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(() => {
      currentJob = null;
      cancelRequested = false;
    });

  return { ok: true };
}

async function runSummaryJob(jobId, context) {
  const {
    pageUrl,
    pdfUrl,
    project,
    scrapboxBase,
    model,
    apiKey
  } = context;

  const cancelReason = () => new Error("ユーザーが処理を中断しました");

  function throwIfCancelled() {
    if (cancelRequested) {
      const error = cancelReason();
      error.name = "CancellationError";
      throw error;
    }
  }

  async function pushLog(message) {
    await chrome.runtime.sendMessage({
      type: "offscreen-log",
      jobId,
      message
    });
  }

  await pushLog("PDFリンクの解析を開始します");
  throwIfCancelled();

  let resolvedPdfUrl = null;
  if (pdfUrl && pdfUrl.trim()) {
    try {
      resolvedPdfUrl = new URL(pdfUrl, pageUrl).toString();
    } catch (err) {
      throw new Error("指定されたPDF URLを正しく解釈できませんでした");
    }
    await pushLog(`指定されたPDF URLを使用します: ${resolvedPdfUrl}`);
  } else {
    if (looksLikePdf(pageUrl)) {
      resolvedPdfUrl = pageUrl;
      await pushLog("ページURL自体がPDFのため、そのまま使用します");
    } else {
      resolvedPdfUrl = await findPdfUrl(pageUrl);
      await pushLog(`PDF URLを推定しました: ${resolvedPdfUrl}`);
    }
  }

  throwIfCancelled();
  const { file, bufferLength } = await downloadPdf(resolvedPdfUrl, pageUrl);
  await pushLog(`PDFダウンロード完了 (${(bufferLength / 1024).toFixed(1)} KB)`);

  throwIfCancelled();

  let uploadedFileId = null;
  try {
    const uploadResult = await uploadFileToOpenAI(file, apiKey);
    uploadedFileId = uploadResult && uploadResult.id;
    if (!uploadedFileId) {
      throw new Error("OpenAIがファイルIDを返しませんでした");
    }
    await pushLog("OpenAIへファイルをアップロードしました");

    throwIfCancelled();

    const title = await requestTitle(uploadedFileId, model, apiKey);
    if (!title) {
      throw new Error("タイトルを取得できませんでした");
    }
    await pushLog(`タイトルを取得しました: ${title}`);

    throwIfCancelled();

    const summary = await requestSummaryText(uploadedFileId, model, apiKey);
    if (!summary) {
      throw new Error("要約を取得できませんでした");
    }
    await pushLog(`要約を取得しました (文字数: ${summary.length})`);

    throwIfCancelled();

    const scrapboxUrl = buildScrapboxUrl(scrapboxBase, project, title, summary);
    await pushLog("Scrapboxページを開きます...");

    await notifyResult(jobId, "success", {
      title,
      summaryLength: summary.length,
      scrapboxUrl
    });
    await pushLog("処理が完了しました");
  } catch (error) {
    if (error && error.name === "CancellationError") {
      await pushLog(error.message);
      await notifyResult(jobId, "aborted", { error: error.message });
    } else {
      const message = error instanceof Error ? error.message : String(error);
      await pushLog(`エラー: ${message}`);
      await notifyResult(jobId, "error", { error: message });
    }
  } finally {
    if (uploadedFileId) {
      try {
        await deleteUploadedFile(uploadedFileId, apiKey);
        await pushLog("OpenAIの一時ファイルを削除しました");
      } catch (err) {
        console.warn("Failed to delete uploaded file", err);
      }
    }
  }
}

async function notifyResult(jobId, status, payload = {}) {
  await chrome.runtime.sendMessage({
    type: "offscreen-result",
    jobId,
    status,
    payload
  });
}

async function findPdfUrl(pageUrl) {
  const direct = deriveDirectPdfUrl(pageUrl);
  if (direct) {
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
      const rawName = segments[segments.length - 1] || "paper";
      return rawName.toLowerCase().endsWith(".pdf") ? rawName : `${rawName}.pdf`;
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
  const titleText = await requestTextFromOpenAI(
    uploadedFileId,
    model,
    apiKey,
    prompt,
    "タイトル抽出"
  );
  return titleText.split(/\r?\n/)[0].trim();
}

async function requestSummaryText(uploadedFileId, model, apiKey) {
  const prompt = await loadPromptFile("summarization_prompt.txt");
  const rawText = await requestTextFromOpenAI(
    uploadedFileId,
    model,
    apiKey,
    prompt,
    "要約生成"
  );
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
      ]
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

async function loadPromptFile(filename) {
  if (promptCache.has(filename)) {
    return promptCache.get(filename);
  }
  const url = chrome.runtime.getURL(filename);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`${filename} の読み込みに失敗しました (status ${response.status})`);
  }
  const text = (await response.text()).trim();
  if (!text) {
    throw new Error(`${filename} が空です`);
  }
  promptCache.set(filename, text);
  return text;
}
