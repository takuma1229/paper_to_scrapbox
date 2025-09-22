const DEFAULT_HEADERS = {
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
};

const statusEl = document.getElementById("status");
const formEl = document.getElementById("summary-form");
const inputPageUrl = document.getElementById("page-url");
const inputPdfUrl = document.getElementById("pdf-url");
const inputProject = document.getElementById("project");
const inputScrapboxBase = document.getElementById("scrapbox-base");
const inputApiKey = document.getElementById("api-key");
const inputModel = document.getElementById("model");

const promptCache = {};
const promptPromises = {};

function logStatus(message) {
  const timestamp = new Date().toLocaleTimeString();
  statusEl.textContent += `[${timestamp}] ${message}\n`;
  statusEl.scrollTop = statusEl.scrollHeight;
}

function clearStatus() {
  statusEl.textContent = "";
}

function sanitizeBaseUrl(value) {
  return value.replace(/\/$/, "");
}

function uniquePush(list, value) {
  if (!list.includes(value)) {
    list.push(value);
  }
}

async function storageGet(keys) {
  return new Promise((resolve) => {
    chrome.storage.local.get(keys, (items) => {
      resolve(items || {});
    });
  });
}

async function storageSet(items) {
  return new Promise((resolve) => {
    chrome.storage.local.set(items, () => resolve());
  });
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

async function findPdfUrl(pageUrl) {
  const direct = deriveDirectPdfUrl(pageUrl);
  if (direct) {
    logStatus(`既知パターンからPDFを推定: ${direct}`);
    return direct;
  }

  logStatus("ページHTMLを取得中...");
  const response = await fetch(pageUrl, {
    method: "GET",
    headers: DEFAULT_HEADERS,
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`ページ取得に失敗しました (status ${response.status})`);
  }
  const html = await response.text();
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const pdfCandidates = [];

  const anchors = doc.querySelectorAll("a[href]");
  for (const anchor of anchors) {
    const href = anchor.getAttribute("href");
    if (!href) {
      continue;
    }
    let resolved;
    try {
      resolved = new URL(href, pageUrl).toString();
    } catch (err) {
      continue;
    }
    if (looksLikePdf(resolved, anchor.textContent, anchor.getAttribute("type"))) {
      logStatus(`PDFリンク候補: ${resolved}`);
      if (resolved.toLowerCase().endsWith(".pdf")) {
        return resolved;
      }
      uniquePush(pdfCandidates, resolved);
    }
  }

  const meta = doc.querySelector('meta[name="citation_pdf_url"]');
  if (meta && meta.content) {
    try {
      const resolved = new URL(meta.content, pageUrl).toString();
      logStatus(`metaタグのPDF候補: ${resolved}`);
      if (resolved.toLowerCase().endsWith(".pdf")) {
        return resolved;
      }
      uniquePush(pdfCandidates, resolved);
    } catch (err) {
      // ignore
    }
  }

  const linkTags = doc.querySelectorAll("link[href]");
  for (const linkTag of linkTags) {
    const type = (linkTag.getAttribute("type") || "").toLowerCase();
    if (type === "application/pdf") {
      try {
        const resolved = new URL(linkTag.getAttribute("href"), pageUrl).toString();
        logStatus(`linkタグのPDF候補: ${resolved}`);
        if (resolved.toLowerCase().endsWith(".pdf")) {
          return resolved;
        }
        uniquePush(pdfCandidates, resolved);
      } catch (err) {
        // ignore
      }
    }
  }

  if (pdfCandidates.length > 0) {
    logStatus(`候補一覧からPDFを選択: ${pdfCandidates[0]}`);
    return pdfCandidates[0];
  }

  throw new Error("PDFリンクを検出できませんでした");
}

async function downloadPdf(pdfUrl) {
  logStatus(`PDFダウンロード中: ${pdfUrl}`);
  const response = await fetch(pdfUrl, {
    method: "GET",
    credentials: "include"
  });
  if (!response.ok) {
    throw new Error(`PDFダウンロードに失敗しました (status ${response.status})`);
  }
  const buffer = await response.arrayBuffer();
  if (!buffer || buffer.byteLength === 0) {
    throw new Error("PDFデータが空でした");
  }
  const filename = (() => {
    try {
      const parsed = new URL(pdfUrl);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length > 0) {
        return segments[segments.length - 1] || "paper.pdf";
      }
    } catch (err) {
      // ignore
    }
    return "paper.pdf";
  })();
  const file = new File([buffer], filename, { type: "application/pdf" });
  return { file, bufferLength: buffer.byteLength };
}

async function uploadFileToOpenAI(file, apiKey) {
  logStatus("OpenAIへファイルをアップロード...");
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
  const joined = chunks.map((chunk) => chunk.trim()).filter(Boolean).join("\n").trim();
  if (!joined) {
    throw new Error("OpenAIレスポンスからテキストを取得できませんでした");
  }
  return joined;
}

async function requestTextFromOpenAI(uploadedFileId, model, apiKey, userPrompt, description) {
  const systemPrompt = "あなたは日本語で簡潔かつ正確に情報を伝える研究支援アシスタントです。指示された形式を厳守してください。";

  logStatus(`OpenAIへ${description}をリクエスト...`);
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
      temperature: 0.2
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

async function requestTitle(uploadedFileId, model, apiKey) {
  const prompt = await loadTitlePrompt();
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
  const prompt = await loadSummarizationPrompt();
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

async function deleteUploadedFile(fileId, apiKey) {
  if (!fileId) {
    return;
  }
  try {
    await fetch(`https://api.openai.com/v1/files/${fileId}`, {
      method: "DELETE",
      headers: {
        Authorization: `Bearer ${apiKey}`
      }
    });
  } catch (err) {
    console.warn("Failed to delete uploaded file", err);
  }
}

function buildScrapboxUrl(baseUrl, project, title, summary) {
  const trimmedBase = sanitizeBaseUrl(baseUrl);
  const encodedProject = encodeURIComponent(project);
  const encodedTitle = encodeURIComponent(title);
  const bodyText = (summary || "").trim();
  const encodedBody = encodeURIComponent(bodyText);
  return `${trimmedBase}/${encodedProject}/${encodedTitle}?body=${encodedBody}`;
}

function openScrapboxTab(url) {
  return new Promise((resolve, reject) => {
    chrome.tabs.create({ url }, (tab) => {
      const maybeError = chrome.runtime.lastError;
      if (maybeError) {
        reject(new Error(maybeError.message));
        return;
      }
      resolve(tab);
    });
  });
}

async function runSummaryFlow(options) {
  const {
    pageUrl,
    pdfUrl,
    project,
    scrapboxBase,
    model,
    apiKey
  } = options;

  let resolvedPdfUrl = pdfUrl;
  if (!resolvedPdfUrl) {
    resolvedPdfUrl = await findPdfUrl(pageUrl);
  }

  const { file } = await downloadPdf(resolvedPdfUrl);
  logStatus(`PDFサイズ: ${(file.size / 1024).toFixed(1)} KB`);

  const uploadResult = await uploadFileToOpenAI(file, apiKey);
  const uploadedFileId = uploadResult && uploadResult.id;
  if (!uploadedFileId) {
    throw new Error("OpenAIがファイルIDを返しませんでした");
  }

  let title;
  let summary;
  try {
    title = await requestTitle(uploadedFileId, model, apiKey);
    if (!title) {
      throw new Error("タイトルを取得できませんでした");
    }
    logStatus(`検出タイトル: ${title}`);

    summary = await requestSummaryText(uploadedFileId, model, apiKey);
    summary = summary.trim();
    if (!summary) {
      throw new Error("要約を取得できませんでした");
    }
    logStatus(`要約文字数: ${summary.length}`);
  } finally {
    deleteUploadedFile(uploadedFileId, apiKey);
  }

  const scrapboxUrl = buildScrapboxUrl(scrapboxBase, project, title, summary);
  logStatus("Scrapboxページを開きます...");
  await openScrapboxTab(scrapboxUrl);
  logStatus("処理が完了しました");
}

async function loadPromptFile(filename) {
  if (promptCache[filename]) {
    return promptCache[filename];
  }
  if (!promptPromises[filename]) {
    promptPromises[filename] = (async () => {
      const url = chrome.runtime.getURL(filename);
      try {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        const text = (await response.text()).trim();
        if (!text) {
          throw new Error("空のプロンプトファイル");
        }
        promptCache[filename] = text;
        return text;
      } catch (err) {
        console.error(`Failed to load prompt: ${filename}`, err);
        throw new Error("プロンプトの読み込みに失敗しました");
      }
    })();
  }
  return promptPromises[filename];
}

async function loadTitlePrompt() {
  return loadPromptFile("title_prompt.txt");
}

async function loadSummarizationPrompt() {
  return loadPromptFile("summarization_prompt.txt");
}

function setFormDisabled(disabled) {
  const elements = formEl.querySelectorAll("input, button, select, textarea");
  elements.forEach((el) => {
    el.disabled = disabled;
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
      // ignore invalid URLs (e.g., chrome://)
    }
  });
}

formEl.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearStatus();
  setFormDisabled(true);

  const pageUrl = inputPageUrl.value.trim();
  const pdfUrl = inputPdfUrl.value.trim();
  const project = inputProject.value.trim();
  const scrapboxBase = inputScrapboxBase.value.trim();
  const apiKey = inputApiKey.value.trim();
  const model = inputModel.value.trim();

  if (!pageUrl || !project || !apiKey || !model || !scrapboxBase) {
    logStatus("必要な項目が未入力です");
    setFormDisabled(false);
    return;
  }

  try {
    await persistFormValues();
    await runSummaryFlow({
      pageUrl,
      pdfUrl: pdfUrl || null,
      project,
      scrapboxBase,
      apiKey,
      model
    });
  } catch (err) {
    console.error(err);
    logStatus(`エラー: ${err.message || err.toString()}`);
  } finally {
    setFormDisabled(false);
  }
});

restoreFormValues()
  .catch((err) => {
    console.error("Failed to restore form values", err);
  })
  .finally(() => {
    prefillCurrentTabUrl();
  });

Promise.all([loadTitlePrompt(), loadSummarizationPrompt()]).catch((err) => {
  console.error(err);
});
