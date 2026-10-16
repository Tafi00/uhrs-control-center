(() => {
  const JUNK_OPTIONS = [
    "Not Junk",
    "Error Message / Page not found / No results",
    "Low / No Content / Ads only pages",
    "Site unreachable",
    "Automatic Redirection",
    "Other type of Junk",
    "Can't Judge"
  ];

  function text(value) {
    return String(value == null ? "" : value).replace(/\s+/g, " ").trim();
  }

  function normalizeAnswer(value) {
    return text(value).toLowerCase()
      .normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
      .replace(/đ/g, "d")
      .replace(/[’']/g, "'").replace(/\s+/g, " ").trim();
  }

  // The change-question row is a control row in the Sheet, not a HIT URL.
  // Sheets sometimes contain the task-group query twice (for example
  // `...?taskgroupid=178599?taskgroupid=178599`). Keep only the first numeric
  // task group so every profile navigates to the same valid UHRS URL.
  function canonicalTaskGroupUrl(value) {
    const raw = text(value);
    if (!raw) return "";
    try {
      const url = new URL(raw);
      const appMatch = url.pathname.match(/^\/marketplace\/app\/(\d+)\/?$/i);
      if (!appMatch || !/(?:^|\.)uhrs\.ai$/i.test(url.hostname)) return "";
      const query = raw.match(/[?&]taskgroupid=(\d+)/i);
      if (!query) return "";
      url.hash = "";
      url.search = `?taskgroupid=${query[1]}`;
      return url.href;
    } catch {
      return "";
    }
  }

  function normalizeUrl(value) {
    const raw = text(value);
    if (!raw) return "";
    const taskGroupUrl = canonicalTaskGroupUrl(raw);
    if (taskGroupUrl) {
      try {
        const canonical = new URL(taskGroupUrl);
        canonical.protocol = canonical.protocol.toLowerCase();
        canonical.hostname = canonical.hostname.toLowerCase().replace(/^www\./, "");
        return canonical.href;
      } catch {}
    }
    try {
      const url = new URL(raw);
      url.protocol = url.protocol.toLowerCase();
      url.hostname = url.hostname.toLowerCase().replace(/^www\./, "");
      url.hash = "";
      url.pathname = url.pathname.replace(/\/+$/, "") || "/";
      const pairs = [...url.searchParams.entries()].sort((a, b) => {
        const left = `${a[0]}=${a[1]}`;
        const right = `${b[0]}=${b[1]}`;
        return left.localeCompare(right);
      });
      url.search = pairs.length ? `?${new URLSearchParams(pairs).toString()}` : "";
      return url.href;
    } catch {
      return raw.toLowerCase().replace(/^https?:\/\/www\./, value => value.replace("www.", "")).replace(/\/+$/, "");
    }
  }

  function skipAnswer(value) {
    const answer = normalizeAnswer(value).replace(/[._-]+/g, " ");
    return /^(doi|doi cau|change|skip|next question|bo qua)(\s|$)/i.test(answer) ||
      /^(?:link\s+)?(?:đổi|đổi câu|bỏ qua)(\s|$)/i.test(text(value).toLowerCase());
  }

  function optionTexts(options) {
    return (Array.isArray(options) ? options : [])
      .map((option, index) => ({
        index,
        id: text(option?.id || String.fromCharCode(65 + index)),
        text: text(option?.text || option?.label || option)
      }))
      .filter(option => option.text);
  }

  // The sheet stores both option text and compact values such as 1, 2, 4,
  // "2 ok" and "1Đ". Resolve those values against the options currently on
  // screen, so the extension never assumes a stale DOM order.
  function canonicalAnswer(answer, options) {
    const raw = text(answer);
    if (!raw) return "";
    if (skipAnswer(raw)) return "Đổi";
    const visible = optionTexts(options);
    const normalized = normalizeAnswer(raw);
    if (/^(?:ko|khong)\s+cham(?:\s|$)/i.test(normalized)) return "Can't Judge";
    const numeric = normalized.match(/^(?:option\s*)?([1-9])(?:\s*(?:ok|d|đ|đung|dung|correct|true))?$/i);
    if (numeric) {
      const index = Number(numeric[1]) - 1;
      // Sheet numbers use the published Junk Type order, not the order in
      // which the extractor happened to discover DOM nodes. Prefer the
      // canonical label and only use the visible label with the same text.
      if (JUNK_OPTIONS[index]) {
        return visible.find(option => normalizeAnswer(option.text) === normalizeAnswer(JUNK_OPTIONS[index]))?.text || JUNK_OPTIONS[index];
      }
    }
    const letter = normalized.match(/^([a-g])(?:\s*(?:ok|d|đ|correct))?$/i);
    if (letter) {
      const index = letter[1].charCodeAt(0) - 97;
      if (JUNK_OPTIONS[index]) {
        return visible.find(option => normalizeAnswer(option.text) === normalizeAnswer(JUNK_OPTIONS[index]))?.text || JUNK_OPTIONS[index];
      }
    }
    const exact = visible.find(option => normalizeAnswer(option.text) === normalized);
    if (exact) return exact.text;
    const allowed = visible.find(option => {
      const label = normalizeAnswer(option.text);
      return label && (label.includes(normalized) || normalized.includes(label));
    });
    if (allowed) return allowed.text;
    const builtIn = JUNK_OPTIONS.find(option => normalizeAnswer(option) === normalized);
    return builtIn && visible.length ? (visible.find(item => normalizeAnswer(item.text) === normalized)?.text || builtIn) : "";
  }

  function merge(...sources) {
    const rows = sources.flatMap(source => {
      if (Array.isArray(source)) return source;
      if (Array.isArray(source?.records)) return source.records;
      if (Array.isArray(source?.memory)) return source.memory;
      return [];
    });
    const seen = new Set();
    return rows.filter(row => {
      if (!row || typeof row !== "object") return false;
      const target = normalizeUrl(row.normalizedTargetUrl || row.targetUrl || row.url);
      const answer = text(row.answer || row.suggestedAnswer);
      const question = text(row.normalizedQuestion || row.question);
      const key = `${target}|${answer.toLowerCase()}|${question.toLowerCase()}`;
      if (!target && !question) return false;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 3000);
  }

  // The bundled Sheet snapshot is small enough to ship with the extension,
  // but a linear scan on every polling tick still does needless work. Index
  // normalized target URLs once when the snapshot loads.
  function createIndex(records) {
    const index = new Map();
    const addKey = (key, row) => {
      if (!key) return;
      const rows = index.get(key) || [];
      if (!rows.includes(row)) rows.push(row);
      index.set(key, rows);
    };
    for (const row of (Array.isArray(records) ? records : [])) {
      const target = normalizeUrl(row?.normalizedTargetUrl || row?.targetUrl || row?.url);
      addKey(target, row);
      const matchTarget = normalizeUrl(row?.matchUrl);
      if (matchTarget && matchTarget !== target) addKey(matchTarget, row);
      const rawKey = text(row?.targetUrl || row?.url).toLowerCase();
      if (rawKey && rawKey !== target) addKey(rawKey, row);
    }
    return index;
  }

  function find(records, scan, index = null) {
    const extraction = scan?.questionExtraction || {};
    const options = extraction.options || [];
    const rawCandidates = [
      scan?.targetUrl,
      ...(Array.isArray(scan?.targetUrlCandidates) ? scan.targetUrlCandidates : []),
      extraction.targetUrl
    ].map(text).filter(Boolean);
    const targetCandidates = [
      ...rawCandidates.map(normalizeUrl),
      ...rawCandidates.map(v => v.toLowerCase())
    ].filter(Boolean);
    const rows = Array.isArray(records) ? records : [];
    const targetIndex = index instanceof Map ? index : createIndex(rows);
    // Junk Type? is shared by every HIT, so matching by question text can pick
    // an unrelated row. Only an exact normalized target URL is a Sheet hit.
    let targetRows = [];
    for (const target of [...new Set(targetCandidates)]) {
      const matches = targetIndex.get(target) || [];
      if (matches.length) {
        targetRows = matches;
        break;
      }
    }
    // The selected Google Sheet tab is the operator's authoritative answer
    // source. A prior local/AI correction must never replace an exact Sheet
    // row. Those secondary sources are considered only for a Sheet miss.
    const sheetRows = targetRows.filter(row =>
      /^google-sheet-(?:live|bundled)$/i.test(String(row?.source || "")) ||
      String(row?.sheetName || "") === "Trang tính1"
    );
    if (sheetRows.length) targetRows = sheetRows;
    const answers = targetRows.map(row => canonicalAnswer(row.answer || row.suggestedAnswer, options)).filter(Boolean);
    const unique = [...new Set(answers.map(normalizeAnswer))];
    if (unique.length === 1) {
      const answer = answers[0];
      if (skipAnswer(answer)) return { action: "skip", answer: "Đổi", source: targetRows[0]?.source || "answer-memory", confidence: 1, reason: "Sheet memory says đổi câu." };
      return { action: "answer", answer, source: targetRows[0]?.source || "answer-memory", confidence: Number(targetRows[0]?.confidence || 1) || 1, deterministic: true, reason: "Matched stored answer." };
    }
    if (unique.length > 1) {
      // If the user appended a newer "đổi câu" row at the bottom of the Sheet
      // to override an older answer (e.g. disneyland.disney.go.com row 384 vs row 141),
      // honor the newer skip instruction.
      const lastAnswer = answers[answers.length - 1];
      if (skipAnswer(lastAnswer)) {
        return {
          action: "skip",
          answer: "Đổi",
          source: targetRows[targetRows.length - 1]?.source || "answer-memory",
          confidence: 1,
          reason: "Latest Sheet row overrides with đổi câu."
        };
      }
      return { action: "review", source: "answer-memory", confidence: 0, reason: "Multiple stored answers conflict for this target." };
    }
    // No Sheet answer is intentionally not guessed. The caller must stop and
    // let the operator choose manually; in particular, never default to the
    // first radio (Not Junk).
    return null;
  }

  function changeQuestionUrl(records, appId = "") {
    const wantedAppId = text(appId).match(/\d+/)?.[0] || "";
    for (const row of (Array.isArray(records) ? records : [])) {
      const answer = normalizeAnswer(row?.answer || row?.suggestedAnswer || "");
      const notes = normalizeAnswer(row?.notes || "");
      if (!/(?:link\s+)?doi\s+cau|change\s+question|skip\s+question/i.test(`${answer} ${notes}`)) continue;
      const candidate = canonicalTaskGroupUrl(row?.targetUrl || row?.url || row?.matchUrl || "");
      if (!candidate) continue;
      const candidateAppId = new URL(candidate).pathname.match(/\/marketplace\/app\/(\d+)/i)?.[1] || "";
      if (!wantedAppId || candidateAppId === wantedAppId) return candidate;
    }
    return "";
  }

  function loadLocal() {
    return new Promise(resolve => {
      try {
        if (!globalThis.chrome?.storage?.local) return resolve([]);
        chrome.storage.local.get({ uhrsWatcherAnswerMemory: [] }, value => resolve(Array.isArray(value?.uhrsWatcherAnswerMemory) ? value.uhrsWatcherAnswerMemory : []));
      } catch { resolve([]); }
    });
  }

  function rememberLocal(record) {
    return new Promise(resolve => {
      try {
        if (!globalThis.chrome?.storage?.local) return resolve(false);
        chrome.storage.local.get({ uhrsWatcherAnswerMemory: [] }, value => {
          const next = merge([record], value?.uhrsWatcherAnswerMemory || []);
          chrome.storage.local.set({ uhrsWatcherAnswerMemory: next }, () => resolve(true));
        });
      } catch { resolve(false); }
    });
  }

  globalThis.UHRSWatcherAnswerMemory = {
    normalizeUrl,
    canonicalTaskGroupUrl,
    changeQuestionUrl,
    canonicalAnswer,
    createIndex,
    find,
    merge,
    loadLocal,
    rememberLocal,
    skipAnswer
  };
})();
