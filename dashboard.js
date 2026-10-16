(() => {
  const DEFAULT_SETTINGS = {
    remoteServerEnabled: true,
    serverUrl: "http://127.0.0.1:8790/api/action",
    configUrl: "http://127.0.0.1:8790/api/settings",
    commandUrl: "http://127.0.0.1:8790/api/commands",
    dashboardUrl: "dashboard.html",
    profile: "",
    userName: "",
    proxyName: "",
    adsPowerProfile: "",
    adsPowerProfileId: "",
    adsPowerApiEnabled: true,
    adsPowerApiUrl: "http://local.adspower.net:50325",
    networkIdentityEnabled: true,
    identityRefreshSeconds: 300,
    networkIp: "",
    networkCountry: "",
    networkRegion: "",
    networkCity: "",
    networkProvider: "",
    adsPowerProxyIp: "",
    adsPowerProxyCountry: "",
    appId: "63766",
    skipTaskGroupId: "178599",
    sheetId: "1Px75lVqZHnwRuvwzA83YmVj_I0sLm9EbBS-mpG_GOL0",
    sheetGid: "1271800557",
    refreshSeconds: 30,
    answerDelayMinSeconds: 17,
    answerDelayMaxSeconds: 23,
    autoAnswerSettleMs: 1500,
    enabled: true,
    autoAnswerEnabled: true,
    stopOnNoHit: false,
    autoOpenTask: false
  };

  const isExtensionEnv = Boolean(globalThis.chrome?.storage?.local);

  const state = {
    activeTab: new URL(location.href).searchParams.get("tab") || "monitor",
    theme: localStorage.getItem("uhrsDashTheme") || "dark",
    soundEnabled: localStorage.getItem("uhrsDashSound") !== "false",
    lastSoundAlertAt: "",
    settings: { ...DEFAULT_SETTINGS },
    liveTabState: null,
    activeStatesByTab: {},
    profileRegistry: {},
    adsPowerProfiles: [],
    sheetRecords: [],
    localLearnedRecords: [],
    sheetSourceLabel: "Live Google Sheet",
    questionHistory: [],
    eventHistory: [],
    profileFilter: "all",
    profileSearch: "",
    sheetFilter: "all",
    sheetSearch: "",
    historyFilter: "questions",
    quickLookupQuery: ""
  };

  function $(id) {
    return document.getElementById(id);
  }

  function applyTheme(theme) {
    const valid = theme === "light" ? "light" : "dark";
    state.theme = valid;
    document.documentElement.setAttribute("data-theme", valid);
    localStorage.setItem("uhrsDashTheme", valid);
  }

  applyTheme(state.theme);

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, ch => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#039;"
    }[ch]));
  }

  function showToast(text) {
    const el = $("toast");
    if (!el) return;
    el.textContent = text;
    el.classList.add("show");
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => el.classList.remove("show"), 2400);
  }

  function playHitBeep() {
    if (!state.soundEnabled) return;
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.001, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.14, ctx.currentTime + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.45);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.5);
    } catch {}
  }

  function statusMeta(status) {
    const map = {
      hit_available: { label: "Đang xử lý HIT", badge: "badge-hit", dot: "dot-hit" },
      marketplace_available: { label: "Chợ có Task", badge: "badge-info", dot: "dot-hit" },
      waiting_20m: { label: "Đang chờ HIT (F5)", badge: "badge-wait", dot: "dot-wait" },
      waiting: { label: "Đang chờ HIT (F5)", badge: "badge-wait", dot: "dot-wait" },
      two_factor: { label: "Cần xác minh 2FA", badge: "badge-danger", dot: "dot-danger" },
      answer_rejected: { label: "Đáp án bị từ chối", badge: "badge-danger", dot: "dot-danger" },
      error: { label: "Cần kiểm tra lỗi", badge: "badge-danger", dot: "dot-danger" },
      watcher_started: { label: "Đang hoạt động", badge: "badge-info", dot: "dot-hit" },
      idle: { label: "Đang sẵn sàng", badge: "badge-info", dot: "dot-wait" },
      offline: { label: "Chưa mở tab", badge: "", dot: "" }
    };
    return map[status] || { label: status || "Đang chờ", badge: "", dot: "" };
  }

  function isSkipAnswerText(answer) {
    const text = String(answer || "").trim();
    return /^(?:(?:link\s+)?đổi(?:\s*câu)?|(?:link\s+)?doi(?:\s*cau)?|skip(?:\s*question)?|change\s*question)$/i.test(text);
  }

  function describeSheetAnswer(answer) {
    const raw = String(answer || "").trim();
    if (!raw) return "";
    if (isSkipAnswerText(raw)) return `${raw} · Đổi câu (178599)`;
    if (/^(?:ko|không)\s*chấm$/i.test(raw)) return `${raw} · 7 · Can't Judge`;
    if (raw === "0") return "0 · Mặc định chọn 1 (Not Junk)";
    const numMatch = raw.match(/^([1-7])(?:\s*(?:ok|d|đ|đúng|dung))?$/i) || raw.match(/^([1-7])\b/);
    if (!numMatch) return raw;
    const codeMap = {
      "1": "Not Junk",
      "2": "Error Message / Page not found / No results",
      "3": "Low / No Content / Ads only pages",
      "4": "Site unreachable",
      "5": "Automatic Redirection",
      "6": "Other type of Junk",
      "7": "Can't Judge"
    };
    const label = codeMap[numMatch[1]];
    return label ? `${raw} · ${label}` : raw;
  }

  function getAppUrls(settings = state.settings) {
    const appId = encodeURIComponent(String(settings.appId || "63766").trim() || "63766");
    const groupId = (String(settings.skipTaskGroupId || "178599").match(/\d+/) || ["178599"])[0];
    const primaryUrl = `https://www.uhrs.ai/marketplace/app/${appId}`;
    const skipUrl = groupId ? `${primaryUrl}?taskgroupid=${encodeURIComponent(groupId)}` : primaryUrl;
    return {
      primaryUrl,
      skipUrl,
      marketplaceUrl: "https://www.uhrs.ai/marketplace/tasks/all"
    };
  }

  function formatTime(isoString) {
    if (!isoString) return "Chưa có";
    const d = new Date(isoString);
    if (Number.isNaN(d.getTime())) return String(isoString);
    return d.toLocaleTimeString("vi-VN", { hour12: false }) + " · " + d.toLocaleDateString("vi-VN");
  }

  function formatMoney(val) {
    return `$${Number(val || 0).toFixed(4)}`;
  }

  /* Navigation */
  function switchTab(tabName) {
    const valid = ["monitor", "sheet", "history", "settings"].includes(tabName) ? tabName : "monitor";
    state.activeTab = valid;
    document.querySelectorAll(".nav-tab").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.tab === valid);
    });
    document.querySelectorAll(".tab-pane").forEach(pane => {
      pane.classList.toggle("active", pane.id === `pane-${valid}`);
    });
    try {
      const url = new URL(location.href);
      url.searchParams.set("tab", valid);
      history.replaceState(null, "", url);
    } catch {}
  }

  /* Smart Hub URL Discovery */
  let resolvedHubBase = null;

  async function resolveHubBaseUrl() {
    const paramHub = new URL(location.href).searchParams.get("hub");
    if (paramHub) {
      const clean = paramHub.trim().replace(/\/+$/, "");
      localStorage.setItem("uhrsHubBaseUrl", clean);
      resolvedHubBase = clean;
      return resolvedHubBase;
    }
    if (resolvedHubBase !== null) return resolvedHubBase;

    const candidates = [];
    if (location.protocol.startsWith("http") && !/github\.io$/i.test(location.hostname)) {
      candidates.push("");
    }
    const savedHub = localStorage.getItem("uhrsHubBaseUrl");
    if (savedHub) candidates.push(savedHub.replace(/\/+$/, ""));
    candidates.push("http://127.0.0.1:8790");

    try {
      const epRes = await fetch("./hub-endpoint.json?t=" + Date.now(), { cache: "no-store" });
      if (epRes.ok) {
        const ep = await epRes.json();
        if (ep?.hubUrl) {
          candidates.unshift(String(ep.hubUrl).trim().replace(/\/+$/, ""));
        }
      }
    } catch {}

    for (const base of candidates) {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2200);
        const res = await fetch(`${base}/api/health`, { cache: "no-store", signal: ctrl.signal });
        clearTimeout(timer);
        if (res.ok) {
          resolvedHubBase = base;
          return resolvedHubBase;
        }
      } catch {}
    }

    resolvedHubBase = "";
    return resolvedHubBase;
  }

  async function hubFetch(apiPath, options = {}) {
    const base = await resolveHubBaseUrl();
    return fetch(`${base}${apiPath}`, options);
  }

  /* Data Loading */
  async function loadLocalExtensionState() {
    if (!isExtensionEnv) {
      await loadStandaloneServerState();
      return;
    }
    return new Promise(resolve => {
      chrome.storage.local.get(null, stored => {
        const mergedSettings = { ...DEFAULT_SETTINGS };
        for (const key of Object.keys(DEFAULT_SETTINGS)) {
          if (key in stored && stored[key] !== undefined) {
            mergedSettings[key] = stored[key];
          }
        }
        if (/hit-watch-server\.vercel\.app/i.test(String(mergedSettings.serverUrl || ""))) {
          mergedSettings.serverUrl = "http://127.0.0.1:8790/api/action";
          mergedSettings.remoteServerEnabled = false;
        }
        state.settings = mergedSettings;

        const tabStates = {};
        let newestState = stored.uhrsLatestActiveState || null;
        for (const [k, v] of Object.entries(stored)) {
          if (k.startsWith("uhrsWatcherState:") && v && typeof v === "object") {
            tabStates[v.tabId || k] = v;
            if (!newestState || Date.parse(v.at || "") > Date.parse(newestState.at || "")) {
              newestState = v;
            }
          }
        }
        state.activeStatesByTab = tabStates;
        state.liveTabState = newestState;
        state.profileRegistry = stored.uhrsProfileRegistry && typeof stored.uhrsProfileRegistry === "object"
          ? stored.uhrsProfileRegistry
          : {};
        if (Array.isArray(stored.uhrsAdsPowerProfiles) && stored.uhrsAdsPowerProfiles.length) {
          state.adsPowerProfiles = stored.uhrsAdsPowerProfiles;
        }
        state.questionHistory = Array.isArray(stored.uhrsQuestionHistory) ? stored.uhrsQuestionHistory : [];
        state.eventHistory = Array.isArray(stored.uhrsEventHistory) ? stored.uhrsEventHistory : [];
        state.localLearnedRecords = Array.isArray(stored.uhrsLearnedAnswers) ? stored.uhrsLearnedAnswers : [];

        renderAll();
        resolve();
      });
    });
  }

  async function loadStandaloneServerState() {
    try {
      const res = await hubFetch("/api/state", { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      if (data.watcherSettings) {
        state.settings = { ...DEFAULT_SETTINGS, ...data.watcherSettings };
      }
      if (data.activeTabs && typeof data.activeTabs === "object") {
        state.activeStatesByTab = data.activeTabs;
        const sorted = Object.values(data.activeTabs).sort((a, b) => Date.parse(b.lastSeenAt || b.at || "") - Date.parse(a.lastSeenAt || a.at || ""));
        state.liveTabState = sorted[0] || null;
      }
      if (Array.isArray(data.adsPowerProfiles) && data.adsPowerProfiles.length) {
        state.adsPowerProfiles = data.adsPowerProfiles;
      }
      if (Array.isArray(data.profiles)) {
        const reg = {};
        for (const p of data.profiles) {
          const key = p.profileName || p.profile || p.clientId || "Profile";
          reg[key] = {
            key,
            profile: p.profileName || p.profile || "Profile",
            proxyName: p.proxyName || "",
            networkIp: p.networkIp || p.proxyIp || "",
            networkCountry: p.networkCountry || p.proxyCountry || "",
            status: p.status || "idle",
            message: p.message || "",
            lastSeenAt: p.lastSeenAt || "",
            completedCount: p.completedCount || 0,
            skippedCount: p.skippedCount || 0,
            rejectedCount: p.rejectedCount || 0,
            totalEarnings: p.totalEarnings || 0
          };
        }
        state.profileRegistry = reg;
      }
      if (Array.isArray(data.questions)) state.questionHistory = data.questions;
      if (Array.isArray(data.events)) state.eventHistory = data.events;
      renderAll();
    } catch {}
  }

  function parseCsvLine(line) {
    const result = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') {
          cur += '"';
          i += 1;
        } else {
          inQuotes = !inQuotes;
        }
      } else if (ch === "," && !inQuotes) {
        result.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    result.push(cur.trim());
    return result;
  }

  async function loadGoogleSheetRecords(force = false) {
    const rawSheetId = String(state.settings.sheetId || DEFAULT_SETTINGS.sheetId).trim();
    const sheetId = rawSheetId === "1YsI4jFvSIqbsGn6aXCfi84g5jNP3hqcQeWgsrKwk_ys"
      ? DEFAULT_SETTINGS.sheetId
      : rawSheetId;
    state.settings.sheetId = sheetId;
    const sheetGid = String(state.settings.sheetGid || DEFAULT_SETTINGS.sheetGid).trim();
    const sheetLinkEl = $("linkOpenGoogleSheet");
    if (sheetLinkEl) {
      sheetLinkEl.href = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/edit#gid=${encodeURIComponent(sheetGid)}`;
    }

    if (isExtensionEnv && globalThis.chrome?.runtime?.sendMessage) {
      try {
        const res = await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: "fetch_google_sheet", sheetId, sheetGid, force }, reply => resolve(reply || null));
        });
        if (res?.ok && Array.isArray(res.records) && res.records.length) {
          state.sheetRecords = res.records;
          state.sheetSourceLabel = "Live Google Sheet";
          renderKPIs();
          renderSheetTable();
          renderQuickLookup();
          return;
        }
      } catch {}
    }

    if (!isExtensionEnv) {
      try {
        const hubRes = await hubFetch(`/api/sheet?sheetId=${encodeURIComponent(sheetId)}&sheetGid=${encodeURIComponent(sheetGid)}&force=${force ? "1" : "0"}`, { cache: "no-store" });
        if (hubRes.ok) {
          const hubSheet = await hubRes.json();
          if (Array.isArray(hubSheet?.records) && hubSheet.records.length) {
            state.sheetRecords = hubSheet.records;
            state.sheetSourceLabel = hubSheet.sourceLabel || "Live Google Sheet";
            renderKPIs();
            renderSheetTable();
            renderQuickLookup();
            return;
          }
        }
      } catch {}
    }

    try {
      const csvUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(sheetGid)}`;
      const response = await fetch(csvUrl, { cache: "no-store" });
      if (response.ok) {
        const text = await response.text();
        const lines = String(text || "").split(/\r?\n/);
        const records = [];
        let rowNumber = 0;
        for (let idx = 0; idx < lines.length; idx += 1) {
          const cols = parseCsvLine(lines[idx]);
          const targetUrl = String(cols[0] || "").trim();
          const matchUrl = String(cols[1] || "").trim();
          const answer = String(cols[2] || "").trim();
          const statusNote = String(cols[3] || "").trim();
          const refNote = String(cols[4] || "").trim();
          if (!targetUrl && !answer) continue;
          rowNumber += 1;
          records.push({
            id: `sheet-${rowNumber}`,
            source: "google-sheet-live",
            rowNumber,
            targetUrl,
            matchUrl,
            answer,
            notes: [statusNote, refNote].filter(Boolean).join(" | ")
          });
        }
        if (records.length) {
          state.sheetRecords = records;
          state.sheetSourceLabel = "Live Google Sheet";
          renderKPIs();
          renderSheetTable();
          renderQuickLookup();
          return;
        }
      }
    } catch {}

    try {
      const bundledUrl = isExtensionEnv && chrome.runtime?.getURL ? chrome.runtime.getURL("answer-memory.json") : "./answer-memory.json";
      const res = await fetch(bundledUrl);
      if (res.ok) {
        const bundled = await res.json();
        if (Array.isArray(bundled?.records)) {
          state.sheetRecords = bundled.records;
          state.sheetSourceLabel = "Snapshot Sheet Đóng Gói";
          renderKPIs();
          renderSheetTable();
          renderQuickLookup();
        }
      }
    } catch {}
  }

  async function scanAdsPowerProfiles(showNotification = false) {
    const apiUrl = String(state.settings.adsPowerApiUrl || DEFAULT_SETTINGS.adsPowerApiUrl).trim();
    if (isExtensionEnv && globalThis.chrome?.runtime?.sendMessage) {
      try {
        const res = await new Promise(resolve => {
          chrome.runtime.sendMessage({ type: "adspower_profiles", apiUrl }, reply => resolve(reply || null));
        });
        if (res?.ok && Array.isArray(res.profiles)) {
          state.adsPowerProfiles = res.profiles;
          chrome.storage.local.set({ uhrsAdsPowerProfiles: res.profiles, uhrsAdsPowerSyncedAt: new Date().toISOString() });
          renderProfilesSection();
          renderKPIs();
          if (showNotification) showToast(`Đã đồng bộ ${res.profiles.length} Profile từ AdsPower.`);
          return;
        }
      } catch {}
    } else {
      try {
        const res = await hubFetch(`/api/adspower/scan?apiUrl=${encodeURIComponent(apiUrl)}`, { cache: "no-store" });
        if (res.ok) {
          const data = await res.json();
          if (data?.ok && Array.isArray(data.profiles)) {
            state.adsPowerProfiles = data.profiles;
            await loadStandaloneServerState();
            if (showNotification) showToast(`Đã đồng bộ ${data.profiles.length} Profile từ AdsPower.`);
            return;
          }
        }
      } catch {}
    }
    if (showNotification) {
      showToast("Không kết nối được AdsPower Local API (:50325). Đang hiển thị các Profile đã lưu.");
    }
  }

  /* Rendering Functions */
  function renderAll() {
    renderKPIs();
    renderQuickControls();
    renderLiveHitInspector();
    renderQuickLookup();
    renderProfilesSection();
    renderSheetTable();
    renderEarningsAndHistory();
    renderSettingsForm();
  }

  function renderKPIs() {
    const live = state.liveTabState;
    const s = state.settings;
    const currentStatus = live?.status || "waiting_20m";
    const meta = statusMeta(currentStatus);

    if (currentStatus === "hit_available" && live?.at && live.at !== state.lastSoundAlertAt) {
      state.lastSoundAlertAt = live.at;
      playHitBeep();
    }

    const soundBtn = $("btnToggleSound");
    if (soundBtn) {
      soundBtn.textContent = state.soundEnabled ? "Âm báo: BẬT" : "Âm báo: TẮT";
    }

    const topDot = $("topStatusDot");
    if (topDot) {
      topDot.className = `status-dot ${meta.dot || "dot-wait"}`;
    }

    $("kpiStatusValue").textContent = meta.label;
    $("kpiStatusSub").textContent = live?.message || (s.enabled !== false ? `Auto F5 đang chạy (${s.refreshSeconds || 30}s)` : "Auto F5 đang tạm dừng");

    const completedList = state.questionHistory.filter(q => q.status === "completed");
    const skippedList = state.questionHistory.filter(q => q.status === "skipped");
    const rejectedList = state.questionHistory.filter(q => q.status === "rejected");

    const todayStr = new Date().toLocaleDateString("en-CA");
    const monthStr = todayStr.slice(0, 7);

    let todayHits = 0;
    let todayEarn = 0;
    let monthEarn = 0;
    let totalEarn = 0;

    for (const q of completedList) {
      const r = Number(q.reward || 0.03);
      totalEarn += r;
      const d = q.at ? new Date(q.at).toLocaleDateString("en-CA") : "";
      if (d === todayStr) {
        todayHits += 1;
        todayEarn += r;
      }
      if (d.startsWith(monthStr)) {
        monthEarn += r;
      }
    }

    $("kpiCompletedValue").textContent = `${completedList.length} câu`;
    $("kpiCompletedSub").textContent = `${skippedList.length} đổi câu (178599) · ${rejectedList.length} từ chối`;
    $("kpiEarningsValue").textContent = formatMoney(todayEarn);
    $("kpiEarningsSub").textContent = `Tháng: ${formatMoney(monthEarn)} · Tổng: ${formatMoney(totalEarn)}`;

    const minD = Number(s.answerDelayMinSeconds || 17);
    const maxD = Number(s.answerDelayMaxSeconds || 23);
    const f5Sec = Number(s.refreshSeconds || 30);
    $("kpiTimingValue").textContent = `${minD}–${maxD}s · F5 ${f5Sec}s`;
    $("kpiTimingSub").textContent = `Tự trả lời: ${s.autoAnswerEnabled !== false ? "Đang BẬT" : "Đang TẮT"} · Settle ${s.autoAnswerSettleMs || 1500}ms`;

    const allSheet = state.sheetRecords;
    const skipSheetCount = allSheet.filter(r => isSkipAnswerText(r.answer)).length;
    const normalSheetCount = allSheet.length - skipSheetCount;
    $("kpiSheetValue").textContent = `${allSheet.length + state.localLearnedRecords.length} câu`;
    $("kpiSheetSub").textContent = `${normalSheetCount} trả lời tự động · ${skipSheetCount} đổi câu`;
    if ($("navSheetCount")) $("navSheetCount").textContent = String(allSheet.length + state.localLearnedRecords.length);

    const ip = live?.networkIp || s.networkIp || s.adsPowerProxyIp || "139.190.145.67";
    const country = live?.networkCountry || s.networkCountry || s.adsPowerProxyCountry || "JP";
    const profName = live?.adsPowerProfile || live?.profile || s.adsPowerProfile || s.profile || "JP29";
    if ($("kpiProxyValue")) $("kpiProxyValue").textContent = `${profName} · ${ip} (${country})`;
    if ($("kpiProxySub")) $("kpiProxySub").textContent = `Profile ${profName} (${country})`;

    if ($("headerLiveText")) {
      $("headerLiveText").textContent = isExtensionEnv ? "Extension Live" : "Hub Connected";
    }
  }

  function renderQuickControls() {
    const s = state.settings;
    const activeEl = document.activeElement;
    if (
      activeEl &&
      ["quickDelayMin", "quickDelayMax", "quickRefreshSec", "quickAutoAnswer", "topToggleF5"].includes(activeEl.id)
    ) {
      return;
    }
    if ($("quickDelayMin")) $("quickDelayMin").value = Number(s.answerDelayMinSeconds || 17);
    if ($("quickDelayMax")) $("quickDelayMax").value = Number(s.answerDelayMaxSeconds || 23);
    if ($("quickRefreshSec")) $("quickRefreshSec").value = Number(s.refreshSeconds || 30);
    if ($("quickAutoAnswer")) $("quickAutoAnswer").checked = s.autoAnswerEnabled !== false;
    if ($("topToggleF5")) $("topToggleF5").checked = s.enabled !== false;
  }

  function renderLiveHitInspector() {
    const live = state.liveTabState;
    const badgeEl = $("liveHitBadge");
    if (!live) {
      badgeEl.className = "badge";
      badgeEl.textContent = "Đang chờ kết nối";
      return;
    }

    const meta = statusMeta(live.status);
    badgeEl.className = `badge ${meta.badge}`;
    badgeEl.textContent = meta.label;

    const targetUrl = String(live.targetUrl || "").trim();
    $("liveTargetUrlText").textContent = targetUrl || "Chưa có bài HIT nào đang mở trên màn hình";

    const openLink = $("btnOpenTargetUrl");
    if (targetUrl && /^https?:\/\//i.test(targetUrl)) {
      openLink.href = targetUrl;
      openLink.style.display = "inline-flex";
    } else {
      openLink.style.display = "none";
    }

    $("liveQuestionText").textContent = live.questionText || (live.status === "hit_available" ? "Đang phân tích câu hỏi..." : "Đang canh F5 tự động...");
    const matchedAns = live.matchedAnswer || live.autoAnswerSelected || "";
    $("liveMatchedAnswer").textContent = matchedAns ? describeSheetAnswer(matchedAns) : "Chưa khớp";

    let actionLabel = "Chờ HIT xuất hiện";
    if (live.autoAnswerRunning && live.autoAnswerSubmitAt > Date.now()) {
      const remain = Math.max(0, Math.ceil((live.autoAnswerSubmitAt - Date.now()) / 1000));
      actionLabel = `Đang đếm ngược Submit (${remain}s)...`;
    } else if (live.lastAutoAnswerResult?.status === "completed") {
      actionLabel = `Đã Submit (${live.lastAutoAnswerResult.answer || ""})`;
    } else if (live.lastAutoAnswerResult?.resultStatus === "changed_question") {
      actionLabel = "Đã chuyển sang nhóm 178599 (Đổi câu)";
    }
    $("liveActionState").textContent = actionLabel;
    $("livePageMessage").textContent = live.message || "Đang hoạt động bình thường";
  }

  function renderQuickLookup() {
    const box = $("quickLookupResult");
    if (!box) return;
    const q = String(state.quickLookupQuery || "").trim().toLowerCase();
    if (!q) {
      box.innerHTML = `<span style="color:var(--text-muted)">Nhập một phần URL hoặc domain để kiểm tra đáp án ngay tại đây.</span>`;
      return;
    }

    const combined = [
      ...state.localLearnedRecords.map(r => ({
        targetUrl: r.targetUrl || "",
        answer: r.answer || "",
        notes: r.notes || "Lưu tại máy",
        isLocal: true
      })),
      ...state.sheetRecords.map(r => ({
        targetUrl: r.targetUrl || r.matchUrl || "",
        answer: r.answer || "",
        notes: r.notes || "",
        rowNumber: r.rowNumber
      }))
    ];

    const matches = combined.filter(r =>
      r.targetUrl.toLowerCase().includes(q) ||
      r.answer.toLowerCase().includes(q) ||
      r.notes.toLowerCase().includes(q)
    ).slice(0, 5);

    if (!matches.length) {
      box.innerHTML = `<span style="color:var(--emerald);font-weight:500">Không có trong Sheet (${state.sheetRecords.length || 535} dòng) &rarr; Tool sẽ <b>TỰ ĐỘNG CHỌN 1 · Not Junk</b> theo chuẩn Phú Ngao Tool.</span>`;
      return;
    }

    box.innerHTML = matches.map(m => {
      const isSkip = isSkipAnswerText(m.answer);
      const badgeCls = isSkip ? "badge-wait" : "badge-hit";
      return `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid var(--border)">
          <div class="mono" style="font-size:11.5px;overflow-wrap:anywhere;flex:1">${escapeHtml(m.targetUrl)}</div>
          <span class="badge ${badgeCls} mono">${escapeHtml(describeSheetAnswer(m.answer))}</span>
        </div>
      `;
    }).join("");
  }

  function buildUnifiedProfilesList() {
    const map = new Map();

    for (const ap of state.adsPowerProfiles) {
      const key = String(ap.profileName || ap.serialNumber || ap.profileId || "").trim();
      if (!key) continue;
      map.set(key, {
        key,
        profileName: ap.profileName || `Profile #${ap.serialNumber || ap.profileId}`,
        serialNumber: ap.serialNumber || "",
        profileId: ap.profileId || "",
        proxyName: ap.proxyName || "",
        networkIp: ap.proxyIp || "",
        networkCountry: ap.proxyCountry || "",
        status: "offline",
        message: "Chưa mở tab UHRS",
        targetUrl: "",
        tabId: null,
        lastSeenAt: "",
        completedCount: 0,
        skippedCount: 0,
        rejectedCount: 0,
        totalEarnings: 0
      });
    }

    for (const [k, reg] of Object.entries(state.profileRegistry || {})) {
      const name = String(reg.profile || k || "JP29").trim();
      const existing = map.get(name) || {
        key: name,
        profileName: name,
        serialNumber: "",
        profileId: "",
        proxyName: "",
        networkIp: "",
        networkCountry: "",
        status: "idle",
        message: "",
        targetUrl: "",
        tabId: null,
        lastSeenAt: "",
        completedCount: 0,
        skippedCount: 0,
        rejectedCount: 0,
        totalEarnings: 0
      };
      existing.proxyName = reg.proxyName || existing.proxyName;
      existing.networkIp = reg.networkIp || existing.networkIp;
      existing.networkCountry = reg.networkCountry || existing.networkCountry;
      existing.status = reg.status || existing.status;
      existing.message = reg.message || existing.message;
      existing.lastSeenAt = reg.lastSeenAt || existing.lastSeenAt;
      existing.completedCount = Number(reg.completedCount || existing.completedCount || 0);
      existing.skippedCount = Number(reg.skippedCount || existing.skippedCount || 0);
      existing.rejectedCount = Number(reg.rejectedCount || existing.rejectedCount || 0);
      existing.totalEarnings = Number(reg.totalEarnings || existing.totalEarnings || 0);
      map.set(name, existing);
    }

    for (const tabState of Object.values(state.activeStatesByTab || {})) {
      const name = String(tabState.adsPowerProfile || tabState.profile || state.settings.adsPowerProfile || state.settings.profile || "JP29").trim();
      const existing = map.get(name) || {
        key: name,
        profileName: name,
        serialNumber: tabState.adsPowerSerial || "40",
        profileId: tabState.adsPowerProfileId || "",
        proxyName: "",
        networkIp: "",
        networkCountry: "",
        status: "idle",
        message: "",
        targetUrl: "",
        tabId: null,
        lastSeenAt: "",
        completedCount: 0,
        skippedCount: 0,
        rejectedCount: 0,
        totalEarnings: 0
      };
      existing.status = tabState.status || existing.status;
      existing.message = tabState.message || existing.message;
      existing.targetUrl = tabState.targetUrl || existing.targetUrl;
      existing.tabId = tabState.tabId || existing.tabId;
      existing.networkIp = tabState.networkIp || tabState.adsPowerProxyIp || existing.networkIp;
      existing.networkCountry = tabState.networkCountry || tabState.adsPowerProxyCountry || existing.networkCountry;
      existing.proxyName = tabState.proxyName || existing.proxyName;
      existing.lastSeenAt = tabState.at || tabState.lastSeenAt || existing.lastSeenAt;
      map.set(name, existing);
    }

    if (map.size === 0) {
      const fallbackName = state.settings.adsPowerProfile || state.settings.profile || "JP29";
      map.set(fallbackName, {
        key: fallbackName,
        profileName: fallbackName,
        serialNumber: "40",
        profileId: state.settings.adsPowerProfileId || "",
        proxyName: state.settings.proxyName || "",
        networkIp: state.settings.networkIp || "139.190.145.67",
        networkCountry: state.settings.networkCountry || "JP",
        status: state.liveTabState?.status || "waiting_20m",
        message: state.liveTabState?.message || "Đang treo F5 canh HIT trên UHRS (63766)",
        targetUrl: state.liveTabState?.targetUrl || "",
        tabId: state.liveTabState?.tabId || null,
        lastSeenAt: state.liveTabState?.at || new Date().toISOString(),
        completedCount: state.questionHistory.filter(q => q.status === "completed").length,
        skippedCount: state.questionHistory.filter(q => q.status === "skipped").length,
        rejectedCount: state.questionHistory.filter(q => q.status === "rejected").length,
        totalEarnings: state.questionHistory.filter(q => q.status === "completed").reduce((sum, q) => sum + Number(q.reward || 0.03), 0)
      });
    }

    return Array.from(map.values()).sort((a, b) => {
      const score = item => {
        if (item.status === "hit_available") return 4;
        if (["two_factor", "answer_rejected", "error"].includes(item.status)) return 3;
        if (item.status !== "offline") return 2;
        return 1;
      };
      return score(b) - score(a) || String(a.profileName).localeCompare(String(b.profileName));
    });
  }

  function renderProfilesSection() {
    const tbody = $("profilesTableBody");
    if (!tbody) return;
    const list = buildUnifiedProfilesList();
    if ($("profileTotalBadge")) $("profileTotalBadge").textContent = String(list.length);

    const filter = state.profileFilter;
    const q = state.profileSearch.trim().toLowerCase();

    const filtered = list.filter(item => {
      if (filter === "hit" && item.status !== "hit_available") return false;
      if (filter === "waiting" && !["waiting", "waiting_20m", "idle", "watcher_started"].includes(item.status)) return false;
      if (filter === "problem" && !["two_factor", "answer_rejected", "error"].includes(item.status)) return false;
      if (q) {
        const hay = `${item.profileName} ${item.serialNumber} ${item.networkIp} ${item.networkCountry} ${item.proxyName} ${item.message}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="4" class="empty-box">Không có Profile nào khớp với bộ lọc hiện tại.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.map(item => {
      const meta = statusMeta(item.status);
      const ipDisplay = item.networkIp
        ? `${item.networkCountry ? item.networkCountry + " · " : ""}${item.networkIp}`
        : (item.proxyName || "Chưa rõ IP");

      return `
        <tr>
          <td>
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-weight:600;color:var(--text)">${escapeHtml(item.profileName)}</span>
              <span class="mono" style="font-size:11px;color:var(--text-muted)">${item.serialNumber ? `#${escapeHtml(item.serialNumber)}` : ""}</span>
            </div>
            <div class="mono" style="font-size:11.5px;color:var(--text-secondary);margin-top:2px">${escapeHtml(ipDisplay)}</div>
          </td>
          <td style="max-width:250px">
            <div style="margin-bottom:4px">
              <span class="badge ${meta.badge}">
                <span class="status-dot ${meta.dot}"></span>
                ${escapeHtml(meta.label)}
              </span>
            </div>
            <div style="color:var(--text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(item.targetUrl || item.message || "Đang canh HIT...")}</div>
            <div class="mono" style="font-size:11px;color:var(--text-muted)">${escapeHtml(formatTime(item.lastSeenAt))}</div>
          </td>
          <td class="mono" style="font-size:12px;white-space:nowrap">
            <div><span style="color:var(--emerald);font-weight:600">${item.completedCount}</span> xong · <span style="color:var(--amber)">${item.skippedCount}</span> đổi</div>
            <div class="amount-positive" style="font-size:11.5px;margin-top:2px">${formatMoney(item.totalEarnings)}</div>
          </td>
          <td style="text-align:right;white-space:nowrap">
            <div style="display:inline-flex;gap:5px">
              <button class="btn btn-sm" data-tab-action="start-f5" data-tab-id="${escapeHtml(item.tabId || "")}">Bật F5</button>
              <button class="btn btn-sm" data-tab-action="stop-f5" data-tab-id="${escapeHtml(item.tabId || "")}">Dừng</button>
              <button class="btn btn-sm" data-tab-action="reload" data-tab-id="${escapeHtml(item.tabId || "")}">Reload</button>
            </div>
          </td>
        </tr>
      `;
    }).join("");
  }

  function renderSheetTable() {
    const tbody = $("sheetTableBody");
    if (!tbody) return;

    const combined = [
      ...state.localLearnedRecords.map((r, i) => ({
        rowNumber: `M${i + 1}`,
        targetUrl: r.targetUrl || r.normalizedTargetUrl || "",
        answer: r.answer || "",
        notes: r.notes || "Lưu tại máy",
        isLocal: true,
        isSkip: isSkipAnswerText(r.answer)
      })),
      ...state.sheetRecords.map((r, i) => ({
        rowNumber: r.rowNumber || i + 1,
        targetUrl: r.targetUrl || r.matchUrl || "",
        answer: r.answer || "",
        notes: r.notes || "",
        isLocal: false,
        isSkip: isSkipAnswerText(r.answer)
      }))
    ];

    const totalCount = combined.length;
    const skipCount = combined.filter(r => r.isSkip).length;
    const normalCount = totalCount - skipCount;

    if ($("sheetStatTotal")) $("sheetStatTotal").textContent = String(totalCount);
    if ($("sheetStatNormal")) $("sheetStatNormal").textContent = String(normalCount);
    if ($("sheetStatSkip")) $("sheetStatSkip").textContent = String(skipCount);
    if ($("sheetStatLocal")) $("sheetStatLocal").textContent = String(state.localLearnedRecords.length);

    const filter = state.sheetFilter;
    const q = state.sheetSearch.trim().toLowerCase();

    const filtered = combined.filter(r => {
      if (filter === "normal" && r.isSkip) return false;
      if (filter === "skip" && !r.isSkip) return false;
      if (filter === "local" && !r.isLocal) return false;
      if (q) {
        const hay = `${r.targetUrl} ${r.answer} ${r.notes}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="6" class="empty-box">Không tìm thấy dòng đáp án nào khớp từ khóa.</td></tr>`;
      return;
    }

    const displayRows = filtered.slice(0, 300);
    tbody.innerHTML = displayRows.map(r => {
      const actionBadge = r.isSkip
        ? `<span class="badge badge-wait">Đổi câu (178599)</span>`
        : `<span class="badge badge-hit">Chọn & Submit</span>`;
      const formattedAnswer = describeSheetAnswer(r.answer);
      return `
        <tr>
          <td class="mono" style="color:var(--text-muted)">${escapeHtml(r.rowNumber)}</td>
          <td class="mono" style="overflow-wrap:anywhere">${escapeHtml(r.targetUrl)}</td>
          <td><span class="badge ${r.isSkip ? "badge-wait" : "badge-info"} mono">${escapeHtml(formattedAnswer)}</span></td>
          <td>${actionBadge}</td>
          <td style="color:var(--text-secondary)">${escapeHtml(r.notes || "-")}</td>
          <td style="text-align:right">
            <button class="btn btn-sm" data-copy-url="${escapeHtml(r.targetUrl)}">Copy</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  function renderEarningsAndHistory() {
    const profileBody = $("earningsByProfileBody");
    const historyBody = $("historyTableBody");
    if (!profileBody || !historyBody) return;

    const todayStr = new Date().toLocaleDateString("en-CA");
    const monthStr = todayStr.slice(0, 7);

    let todayHits = 0;
    let todayAmount = 0;
    let monthHits = 0;
    let monthAmount = 0;
    let totalHits = 0;
    let totalAmount = 0;
    let skipCount = 0;
    let rejectCount = 0;

    const byProfile = new Map();

    for (const q of state.questionHistory) {
      const prof = String(q.profile || state.settings.adsPowerProfile || state.settings.profile || "JP29").trim();
      const row = byProfile.get(prof) || {
        profile: prof,
        proxyInfo: q.networkIp ? `${q.networkCountry ? q.networkCountry + " · " : ""}${q.networkIp}` : (q.proxyName || "139.190.145.67"),
        completed: 0,
        skipped: 0,
        rejected: 0,
        todayAmount: 0,
        monthAmount: 0,
        totalAmount: 0
      };

      const d = q.at ? new Date(q.at).toLocaleDateString("en-CA") : "";
      const reward = Number(q.reward || 0.03);

      if (q.status === "completed") {
        totalHits += 1;
        totalAmount += reward;
        row.completed += 1;
        row.totalAmount += reward;
        if (d === todayStr) {
          todayHits += 1;
          todayAmount += reward;
          row.todayAmount += reward;
        }
        if (d.startsWith(monthStr)) {
          monthHits += 1;
          monthAmount += reward;
          row.monthAmount += reward;
        }
      } else if (q.status === "skipped") {
        skipCount += 1;
        row.skipped += 1;
      } else if (q.status === "rejected") {
        rejectCount += 1;
        row.rejected += 1;
      }

      byProfile.set(prof, row);
    }

    $("earnTodayValue").textContent = formatMoney(todayAmount);
    $("earnTodayHits").textContent = `${todayHits} câu hoàn thành hôm nay`;
    $("earnMonthValue").textContent = formatMoney(monthAmount);
    $("earnMonthHits").textContent = `${monthHits} câu hoàn thành trong tháng`;
    $("earnTotalValue").textContent = formatMoney(totalAmount);
    $("earnTotalHits").textContent = `${totalHits} câu hoàn thành tích lũy`;
    $("earnSkipCount").textContent = `${skipCount} lần`;
    $("earnRejectCount").textContent = `${rejectCount} lần bị từ chối`;

    const profRows = Array.from(byProfile.values());
    if (!profRows.length) {
      profileBody.innerHTML = `<tr><td colspan="8" class="empty-box">Chưa có lịch sử làm câu hỏi nào được ghi nhận.</td></tr>`;
    } else {
      profileBody.innerHTML = profRows.map(r => `
        <tr>
          <td style="font-weight:600">${escapeHtml(r.profile)}</td>
          <td class="mono" style="color:var(--text-secondary)">${escapeHtml(r.proxyInfo)}</td>
          <td class="mono"><b>${r.completed}</b></td>
          <td class="mono">${r.skipped}</td>
          <td class="mono" style="color:${r.rejected > 0 ? "var(--rose)" : "var(--text-muted)"}">${r.rejected}</td>
          <td class="amount-positive">${formatMoney(r.todayAmount)}</td>
          <td class="amount-positive">${formatMoney(r.monthAmount)}</td>
          <td class="amount-positive">${formatMoney(r.totalAmount)}</td>
        </tr>
      `).join("");
    }

    const hf = state.historyFilter;
    if (hf === "events") {
      if (!state.eventHistory.length) {
        historyBody.innerHTML = `<tr><td colspan="6" class="empty-box">Chưa có sự kiện hệ thống nào.</td></tr>`;
        return;
      }
      historyBody.innerHTML = state.eventHistory.slice(0, 150).map(evt => {
        const meta = statusMeta(evt.status);
        return `
          <tr>
            <td class="mono" style="color:var(--text-muted);font-size:11.5px">${escapeHtml(formatTime(evt.at))}</td>
            <td style="font-weight:600">${escapeHtml(evt.profile || "JP29")}</td>
            <td><span class="badge ${meta.badge}">${escapeHtml(meta.label)}</span></td>
            <td class="mono" style="overflow-wrap:anywhere">${escapeHtml(evt.targetUrl || evt.url || "")}</td>
            <td style="color:var(--text-secondary)">${escapeHtml(evt.message || "")}</td>
            <td class="mono" style="color:var(--text-muted)">${evt.confidence ? Math.round(Number(evt.confidence) * 100) + "%" : "-"}</td>
          </tr>
        `;
      }).join("");
      return;
    }

    const qFiltered = state.questionHistory.filter(q => {
      if (hf === "completed") return q.status === "completed";
      if (hf === "skipped") return q.status === "skipped";
      if (hf === "rejected") return q.status === "rejected";
      return true;
    });

    if (!qFiltered.length) {
      historyBody.innerHTML = `<tr><td colspan="6" class="empty-box">Chưa có lịch sử câu hỏi nào trong mục này.</td></tr>`;
      return;
    }

    historyBody.innerHTML = qFiltered.slice(0, 200).map(q => {
      const badge = q.status === "completed"
        ? `<span class="badge badge-hit">Đã Submit</span>`
        : q.status === "skipped"
          ? `<span class="badge badge-wait">Đã Đổi câu</span>`
          : `<span class="badge badge-danger">Bị từ chối</span>`;
      const delaySec = q.elapsedMs ? `${(Number(q.elapsedMs) / 1000).toFixed(1)}s` : "-";
      const rewardStr = q.status === "completed" ? ` · +${formatMoney(q.reward || 0.03)}` : "";
      return `
        <tr>
          <td class="mono" style="color:var(--text-muted);font-size:11.5px">${escapeHtml(formatTime(q.at))}</td>
          <td style="font-weight:600">${escapeHtml(q.profile || "JP29")}</td>
          <td>${badge}</td>
          <td class="mono" style="overflow-wrap:anywhere">${escapeHtml(q.targetUrl || q.question || "")}</td>
          <td>
            <div class="mono" style="font-weight:600">${escapeHtml(describeSheetAnswer(q.answer || ""))}</div>
            <div style="font-size:11.5px;color:var(--text-muted)">${escapeHtml(q.reason || q.source || "")}</div>
          </td>
          <td class="mono">${escapeHtml(delaySec)}${escapeHtml(rewardStr)}</td>
        </tr>
      `;
    }).join("");
  }

  function renderSettingsForm() {
    const form = $("fullSettingsForm");
    if (!form || form.contains(document.activeElement)) return;
    const s = state.settings;
    $("setAppId").value = s.appId || "63766";
    $("setSkipGroup").value = s.skipTaskGroupId || "178599";
    $("setDelayMin").value = Number(s.answerDelayMinSeconds || 17);
    $("setDelayMax").value = Number(s.answerDelayMaxSeconds || 23);
    $("setRefreshSec").value = Number(s.refreshSeconds || 30);
    $("setSettleMs").value = Number(s.autoAnswerSettleMs || 1500);
    $("setEnabledF5").checked = s.enabled !== false;
    $("setAutoAnswer").checked = s.autoAnswerEnabled !== false;
    $("setStopOnNoHit").checked = s.stopOnNoHit === true;
    $("setAutoOpenTask").checked = s.autoOpenTask === true;
    $("setProfileName").value = s.profile || "";
    $("setUserName").value = s.userName || "";
    $("setProxyName").value = s.proxyName || "";
    $("setAdsPowerUrl").value = s.adsPowerApiUrl || "http://local.adspower.net:50325";
    $("setAdsPowerEnabled").checked = s.adsPowerApiEnabled !== false;
    $("setNetworkIdentity").checked = s.networkIdentityEnabled !== false;
    $("setSheetId").value = s.sheetId || DEFAULT_SETTINGS.sheetId;
    $("setSheetGid").value = s.sheetGid || DEFAULT_SETTINGS.sheetGid;
    $("setRemoteServerEnabled").checked = s.remoteServerEnabled === true;
    const cleanBase = String(s.serverUrl || "http://127.0.0.1:8790/api/action").replace(/\/api\/action(?:\?.*)?$/, "");
    $("setServerBaseUrl").value = /hit-watch-server\.vercel\.app/i.test(cleanBase) ? "http://127.0.0.1:8790" : cleanBase;
  }

  /* Actions & Persistence */
  function sendTabCommand(command, args = {}) {
    if (isExtensionEnv && globalThis.chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "send_tab_command", command, args }, () => {
        setTimeout(loadLocalExtensionState, 250);
      });
    } else {
      hubFetch("/api/command", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command, ...args })
      }).then(() => setTimeout(loadStandaloneServerState, 250)).catch(() => {});
    }
  }

  function openOrNavigateUhrsUrl(url) {
    if (isExtensionEnv && globalThis.chrome?.tabs) {
      chrome.tabs.query({ url: ["*://*.uhrs.ai/*"] }, tabs => {
        const first = tabs?.[0];
        if (first?.id) {
          chrome.tabs.update(first.id, { active: true, url });
        } else {
          chrome.tabs.create({ url });
        }
      });
    } else {
      window.open(url, "_blank", "noopener");
    }
  }

  function saveSettingsObject(partial, toastMessage = "Đã lưu và áp dụng thiết lập.") {
    const next = { ...state.settings, ...partial };
    state.settings = next;
    if (isExtensionEnv && globalThis.chrome?.storage?.local) {
      chrome.storage.local.set(next, () => {
        sendTabCommand("SET_DELAY", {
          minSec: next.answerDelayMinSeconds,
          maxSec: next.answerDelayMaxSeconds
        });
        sendTabCommand("SET_REFRESH", {
          refreshSeconds: next.refreshSeconds
        });
        renderAll();
        showToast(toastMessage);
      });
    } else {
      hubFetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(next)
      }).then(() => {
        sendTabCommand("SET_DELAY", {
          minSec: next.answerDelayMinSeconds,
          maxSec: next.answerDelayMaxSeconds
        });
        sendTabCommand("SET_REFRESH", {
          refreshSeconds: next.refreshSeconds
        });
        renderAll();
        showToast(toastMessage);
      }).catch(() => {});
    }
  }

  /* Event Listeners */
  document.querySelectorAll(".nav-tab").forEach(btn => {
    btn.addEventListener("click", () => switchTab(btn.dataset.tab));
  });

  $("btnToggleTheme")?.addEventListener("click", () => {
    applyTheme(state.theme === "dark" ? "light" : "dark");
    showToast(`Đã chuyển sang giao diện ${state.theme === "dark" ? "Tối (Carbon)" : "Sáng (Daylight)"}.`);
  });

  $("btnToggleSound")?.addEventListener("click", () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem("uhrsDashSound", String(state.soundEnabled));
    renderKPIs();
    showToast(state.soundEnabled ? "Đã bật âm báo khi có HIT." : "Đã tắt âm báo HIT.");
  });

  $("btnRefreshAll")?.addEventListener("click", async () => {
    await loadLocalExtensionState();
    await loadGoogleSheetRecords(true);
    await scanAdsPowerProfiles(false);
    showToast("Đã làm mới dữ liệu.");
  });

  $("btnHeaderOpenApp")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().primaryUrl));
  $("btnHeaderOpenSkip")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().skipUrl));
  $("btnOpenSkipGroup")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().skipUrl));
  $("btnOpenPrimaryApp")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().primaryUrl));
  $("btnOpenMarketplace")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().marketplaceUrl));

  $("topToggleF5")?.addEventListener("change", event => {
    const enabled = Boolean(event.target.checked);
    saveSettingsObject({ enabled }, enabled ? "Đã bật Auto F5 canh HIT." : "Đã tạm dừng Auto F5.");
    sendTabCommand(enabled ? "START_F5" : "STOP_F5");
  });

  $("quickAutoAnswer")?.addEventListener("change", event => {
    const autoAnswerEnabled = Boolean(event.target.checked);
    saveSettingsObject({ autoAnswerEnabled }, `Tự trả lời theo Sheet: ${autoAnswerEnabled ? "BẬT" : "TẮT"}`);
  });

  $("btnCmdStartF5")?.addEventListener("click", () => {
    saveSettingsObject({ enabled: true }, "Đã bật Auto F5 canh HIT.");
    sendTabCommand("START_F5");
  });

  $("btnCmdStopF5")?.addEventListener("click", () => {
    saveSettingsObject({ enabled: false }, "Đã tạm dừng Auto F5.");
    sendTabCommand("STOP_F5");
  });

  $("btnCmdScanNow")?.addEventListener("click", () => {
    sendTabCommand("SCAN_NOW");
    showToast("Đã gửi lệnh quét trang UHRS.");
  });

  $("btnCmdShowPanel")?.addEventListener("click", () => {
    sendTabCommand("SHOW_PANEL");
    showToast("Đã bật bảng điều khiển nổi trên tab UHRS.");
  });

  $("btnSaveQuickConfig")?.addEventListener("click", () => {
    const minSec = Math.max(1, Math.min(120, Math.round(Number($("quickDelayMin").value) || 17)));
    const maxSec = Math.max(minSec, Math.min(120, Math.round(Number($("quickDelayMax").value) || 23)));
    const refreshSeconds = Math.max(5, Math.min(120, Math.round(Number($("quickRefreshSec").value) || 30)));
    const autoAnswerEnabled = $("quickAutoAnswer").checked;
    saveSettingsObject(
      {
        answerDelayMinSeconds: minSec,
        answerDelayMaxSeconds: maxSec,
        autoAnswerMinSubmitDelayMs: minSec * 1000,
        refreshSeconds,
        autoAnswerEnabled
      },
      `Đã áp dụng: Delay ${minSec}–${maxSec}s · F5 ${refreshSeconds}s`
    );
  });

  $("quickLookupInput")?.addEventListener("input", event => {
    state.quickLookupQuery = event.target.value || "";
    renderQuickLookup();
  });

  $("btnCopyTargetUrl")?.addEventListener("click", () => {
    const url = state.liveTabState?.targetUrl || "";
    if (!url) {
      showToast("Hiện chưa có Target URL để copy.");
      return;
    }
    navigator.clipboard?.writeText(url);
    showToast("Đã copy Target URL.");
  });

  $("btnScanAdsPower")?.addEventListener("click", () => scanAdsPowerProfiles(true));

  $("profileFilterPills")?.addEventListener("click", event => {
    const btn = event.target.closest("button[data-filter]");
    if (!btn) return;
    state.profileFilter = btn.dataset.filter;
    document.querySelectorAll("#profileFilterPills .filter-pill").forEach(el => {
      el.classList.toggle("active", el === btn);
    });
    renderProfilesSection();
  });

  $("profileSearchInput")?.addEventListener("input", event => {
    state.profileSearch = event.target.value || "";
    renderProfilesSection();
  });

  $("profilesTableBody")?.addEventListener("click", event => {
    const btn = event.target.closest("button[data-tab-action]");
    if (!btn) return;
    const action = btn.dataset.tabAction;
    const tabId = Number(btn.dataset.tabId) || null;
    if (action === "focus" && tabId && isExtensionEnv && globalThis.chrome?.tabs) {
      chrome.tabs.update(tabId, { active: true });
      return;
    }
    if (action === "start-f5") {
      sendTabCommand("START_F5", { tabId });
      showToast("Đã bật F5 cho tab.");
    } else if (action === "stop-f5") {
      sendTabCommand("STOP_F5", { tabId });
      showToast("Đã dừng F5 cho tab.");
    } else if (action === "reload") {
      if (tabId && isExtensionEnv && globalThis.chrome?.tabs) {
        chrome.tabs.reload(tabId);
      } else {
        sendTabCommand("SCAN_NOW", { tabId });
      }
      showToast("Đã làm mới tab UHRS.");
    }
  });

  $("sheetFilterPills")?.addEventListener("click", event => {
    const btn = event.target.closest("button[data-sheet-filter]");
    if (!btn) return;
    state.sheetFilter = btn.dataset.sheetFilter;
    document.querySelectorAll("#sheetFilterPills .filter-pill").forEach(el => {
      el.classList.toggle("active", el === btn);
    });
    renderSheetTable();
  });

  $("sheetSearchInput")?.addEventListener("input", event => {
    state.sheetSearch = event.target.value || "";
    renderSheetTable();
  });

  $("btnForceSyncSheet")?.addEventListener("click", async () => {
    showToast("Đang đồng bộ từ Google Sheet...");
    await loadGoogleSheetRecords(true);
    showToast(`Đã đồng bộ ${state.sheetRecords.length} dòng từ Google Sheet.`);
  });

  $("sheetTableBody")?.addEventListener("click", event => {
    const btn = event.target.closest("button[data-copy-url]");
    if (!btn) return;
    const text = btn.dataset.copyUrl || "";
    navigator.clipboard?.writeText(text);
    showToast("Đã copy URL.");
  });

  $("customMemoryForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const targetUrl = String($("customMemUrl").value || "").trim();
    const answer = String($("customMemAnswer").value || "").trim();
    const notes = String($("customMemNote").value || "").trim();
    if (!targetUrl || !answer) return;

    const entry = {
      id: `local-${Date.now()}`,
      targetUrl,
      normalizedTargetUrl: window.UHRSWatcherAnswerMemory?.normalizeUrl?.(targetUrl) || targetUrl,
      answer,
      notes: notes || "Thêm từ Console",
      learnedAt: new Date().toISOString()
    };
    const nextList = [entry, ...state.localLearnedRecords.filter(r => r.targetUrl !== targetUrl)].slice(0, 500);
    state.localLearnedRecords = nextList;
    if (isExtensionEnv && globalThis.chrome?.storage?.local) {
      chrome.storage.local.set({ uhrsLearnedAnswers: nextList });
    }
    $("customMemUrl").value = "";
    $("customMemNote").value = "";
    renderKPIs();
    renderSheetTable();
    renderQuickLookup();
    showToast(`Đã lưu đáp án "${describeSheetAnswer(answer)}" cho URL.`);
  });

  $("historyFilterPills")?.addEventListener("click", event => {
    const btn = event.target.closest("button[data-hist-filter]");
    if (!btn) return;
    state.historyFilter = btn.dataset.histFilter;
    document.querySelectorAll("#historyFilterPills .filter-pill").forEach(el => {
      el.classList.toggle("active", el === btn);
    });
    renderEarningsAndHistory();
  });

  $("btnExportCsv")?.addEventListener("click", () => {
    const rows = [
      ["ThoiGian", "Profile", "Proxy", "TrangThai", "TargetURL", "DapAn", "DelayGiay", "TienThuongUSD", "GhiChu"]
    ];
    for (const q of state.questionHistory) {
      rows.push([
        q.at || "",
        q.profile || "",
        q.proxyName || "",
        q.status || "",
        q.targetUrl || "",
        q.answer || "",
        q.elapsedMs ? (Number(q.elapsedMs) / 1000).toFixed(1) : "0",
        q.status === "completed" ? Number(q.reward || 0.03).toFixed(4) : "0",
        q.reason || ""
      ]);
    }
    const csvContent = rows
      .map(r => r.map(field => `"${String(field).replace(/"/g, '""')}"`).join(","))
      .join("\r\n");
    const blob = new Blob(["\ufeff" + csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `uhrs-report-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Đã xuất file CSV.");
  });

  $("btnClearHistory")?.addEventListener("click", () => {
    if (!confirm("Xóa toàn bộ lịch sử câu hỏi và sự kiện trên máy này?")) return;
    state.questionHistory = [];
    state.eventHistory = [];
    if (isExtensionEnv && globalThis.chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "clear_watcher_history" }, () => {
        renderKPIs();
        renderEarningsAndHistory();
        showToast("Đã xóa lịch sử.");
      });
    }
  });

  $("fullSettingsForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const minSec = Math.max(1, Math.min(120, Math.round(Number($("setDelayMin").value) || 17)));
    const maxSec = Math.max(minSec, Math.min(120, Math.round(Number($("setDelayMax").value) || 23)));
    const refreshSeconds = Math.max(5, Math.min(120, Math.round(Number($("setRefreshSec").value) || 30)));
    const settleMs = Math.max(500, Math.min(5000, Math.round(Number($("setSettleMs").value) || 1500)));
    const remoteEnabled = $("setRemoteServerEnabled").checked;
    let rawServerBase = String($("setServerBaseUrl").value || "http://127.0.0.1:8790").trim().replace(/\/+$/, "");
    if (!rawServerBase || /hit-watch-server\.vercel\.app/i.test(rawServerBase)) {
      rawServerBase = "http://127.0.0.1:8790";
    }

    const updated = {
      appId: String($("setAppId").value || "63766").trim() || "63766",
      skipTaskGroupId: String($("setSkipGroup").value || "178599").trim() || "178599",
      answerDelayMinSeconds: minSec,
      answerDelayMaxSeconds: maxSec,
      autoAnswerMinSubmitDelayMs: minSec * 1000,
      refreshSeconds,
      autoAnswerSettleMs: settleMs,
      enabled: $("setEnabledF5").checked,
      autoAnswerEnabled: $("setAutoAnswer").checked,
      stopOnNoHit: $("setStopOnNoHit").checked,
      autoOpenTask: $("setAutoOpenTask").checked,
      profile: String($("setProfileName").value || "").trim(),
      userName: String($("setUserName").value || "").trim(),
      proxyName: String($("setProxyName").value || "").trim(),
      adsPowerApiUrl: String($("setAdsPowerUrl").value || "http://local.adspower.net:50325").trim().replace(/\/+$/, ""),
      adsPowerApiEnabled: $("setAdsPowerEnabled").checked,
      networkIdentityEnabled: $("setNetworkIdentity").checked,
      sheetId: String($("setSheetId").value || DEFAULT_SETTINGS.sheetId).trim(),
      sheetGid: String($("setSheetGid").value || DEFAULT_SETTINGS.sheetGid).trim(),
      remoteServerEnabled: remoteEnabled,
      serverUrl: `${rawServerBase}/api/action`,
      configUrl: `${rawServerBase}/api/settings`,
      commandUrl: `${rawServerBase}/api/commands`,
      dashboardUrl: isExtensionEnv && chrome.runtime?.getURL ? chrome.runtime.getURL("dashboard.html") : "dashboard.html"
    };

    saveSettingsObject(updated, "Đã lưu toàn bộ cấu hình hệ thống.");
  });

  $("btnResetDefaults")?.addEventListener("click", () => {
    saveSettingsObject(
      {
        ...DEFAULT_SETTINGS,
        dashboardUrl: isExtensionEnv && chrome.runtime?.getURL ? chrome.runtime.getURL("dashboard.html") : "dashboard.html"
      },
      "Đã khôi phục cấu hình mặc định."
    );
  });

  /* Live Subscriptions & Timers */
  if (isExtensionEnv && globalThis.chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener(() => {
      loadLocalExtensionState();
    });
  }

  setInterval(() => {
    if (state.liveTabState?.autoAnswerSubmitAt > Date.now()) {
      renderLiveHitInspector();
    }
  }, 500);

  setInterval(() => {
    loadLocalExtensionState();
  }, 4000);

  /* Initialize */
  switchTab(state.activeTab);
  loadLocalExtensionState().then(() => {
    loadGoogleSheetRecords(false);
    scanAdsPowerProfiles(false);
  });
})();
