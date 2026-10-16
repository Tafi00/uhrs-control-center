(() => {
  const DEFAULT_SETTINGS = {
    remoteServerEnabled: false,
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
    sheetId: "1YsI4jFvSIqbsGn6aXCfi84g5jNP3hqcQeWgsrKwk_ys",
    sheetGid: "1271800557",
    refreshSeconds: 5,
    answerDelayMinSeconds: 10,
    answerDelayMaxSeconds: 15,
    autoAnswerSettleMs: 1500,
    enabled: true,
    autoAnswerEnabled: true,
    stopOnNoHit: false,
    autoOpenTask: false
  };

  const isExtensionEnv = Boolean(globalThis.chrome?.storage?.local);

  const state = {
    activeTab: new URL(location.href).searchParams.get("tab") || "monitor",
    soundEnabled: localStorage.getItem("uhrsDashSound") !== "false",
    lastSoundAlertAt: "",
    settings: { ...DEFAULT_SETTINGS },
    liveTabState: null,
    activeStatesByTab: {},
    profileRegistry: {},
    adsPowerProfiles: [],
    sheetRecords: [],
    localLearnedRecords: [],
    sheetSourceLabel: "Google Sheet Live",
    questionHistory: [],
    eventHistory: [],
    profileFilter: "all",
    profileSearch: "",
    sheetFilter: "all",
    sheetSearch: "",
    historyFilter: "questions"
  };

  function $(id) {
    return document.getElementById(id);
  }

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
    showToast._timer = setTimeout(() => el.classList.remove("show"), 2600);
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
      hit_available: { label: "Đang xử lý HIT", badge: "badge-hit", dot: "dot-hit", card: "card-hit" },
      marketplace_available: { label: "Chợ có Task", badge: "badge-info", dot: "dot-hit", card: "" },
      waiting_20m: { label: "Đang chờ HIT (F5)", badge: "badge-wait", dot: "dot-wait", card: "" },
      waiting: { label: "Đang chờ HIT (F5)", badge: "badge-wait", dot: "dot-wait", card: "" },
      two_factor: { label: "Cần xác minh 2FA", badge: "badge-danger", dot: "dot-danger", card: "card-problem" },
      answer_rejected: { label: "Đáp án bị từ chối", badge: "badge-danger", dot: "dot-danger", card: "card-problem" },
      error: { label: "Cần kiểm tra lỗi", badge: "badge-danger", dot: "dot-danger", card: "card-problem" },
      watcher_started: { label: "Đang hoạt động", badge: "badge-info", dot: "", card: "" },
      idle: { label: "Đang sẵn sàng", badge: "badge-info", dot: "", card: "" }
    };
    return map[status] || { label: status || "Chưa hoạt động", badge: "", dot: "", card: "" };
  }

  function isSkipAnswerText(answer) {
    const text = String(answer || "").trim();
    return /^(?:đổi(?:\s*câu)?|doi(?:\s*cau)?|skip(?:\s*question)?|change\s*question|\d+\s*[đd]|\d+\s*đổi)$/i.test(text);
  }

  function describeSheetAnswer(answer) {
    const raw = String(answer || "").trim();
    if (!raw) return "";
    if (isSkipAnswerText(raw)) return `${raw} — Đổi câu`;
    const numMatch = raw.match(/^([1-7])\b/);
    if (!numMatch) return raw;
    const codeMap = {
      "1": "Not Junk",
      "2": "Error / Page not found",
      "3": "Site unreachable",
      "4": "Low or no content",
      "5": "Mostly ads / spam",
      "6": "Auto redirect",
      "7": "Can't judge"
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
    const sheetId = String(state.settings.sheetId || DEFAULT_SETTINGS.sheetId).trim();
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
          return;
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
          return;
        }
      }
    } catch {}

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
            return;
          }
        }
      } catch {}
    }

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
          if (showNotification) showToast(`Đã quét ${res.profiles.length} Profile từ AdsPower!`);
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
            if (showNotification) showToast(`Đã quét ${data.profiles.length} Profile từ AdsPower!`);
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
    renderProfilesSection();
    renderSheetTable();
    renderEarningsAndHistory();
    renderSettingsForm();
  }

  function renderKPIs() {
    const live = state.liveTabState;
    const s = state.settings;
    const currentStatus = live?.status || "idle";
    const meta = statusMeta(currentStatus);

    const profileName = live?.adsPowerProfile || live?.profile || s.adsPowerProfile || s.profile || "Profile Hiện Tại";
    $("kpiProfileBadge").textContent = profileName;
    $("kpiStatusDot").className = `status-dot ${meta.dot}`;
    $("kpiStatusText").textContent = meta.label;

    const ip = live?.networkIp || live?.adsPowerProxyIp || s.networkIp || s.adsPowerProxyIp || "Đang lấy IP";
    const country = live?.networkCountry || live?.adsPowerProxyCountry || s.networkCountry || s.adsPowerProxyCountry || "";
    const proxy = live?.proxyName || s.proxyName || "";
    $("kpiNetworkFoot").textContent = [
      `IP: ${ip}`,
      country ? country : "",
      proxy ? `Proxy: ${proxy}` : ""
    ].filter(Boolean).join(" · ");

    const completedCount = state.questionHistory.filter(q => q.status === "completed").length;
    const skippedCount = state.questionHistory.filter(q => q.status === "skipped").length;
    const rejectedCount = state.questionHistory.filter(q => q.status === "rejected").length;
    const openTabCount = Math.max(1, Object.keys(state.activeStatesByTab).length);

    $("kpiHitSummary").textContent = `${completedCount} Submit · ${skippedCount} Đổi`;
    $("kpiRejectedFoot").textContent = `Từ chối: ${rejectedCount} câu · Đang theo dõi: ${openTabCount} tab`;

    const todayStr = new Date().toISOString().slice(0, 10);
    const monthStr = todayStr.slice(0, 7);
    let totalAmount = 0;
    let todayAmount = 0;
    let monthAmount = 0;
    for (const q of state.questionHistory) {
      if (q.status === "completed") {
        const amt = Number(q.reward || 0.025);
        totalAmount += amt;
        const qDate = String(q.at || "").slice(0, 10);
        if (qDate === todayStr) todayAmount += amt;
        if (qDate.slice(0, 7) === monthStr) monthAmount += amt;
      }
    }
    $("kpiEarningsTotal").textContent = formatMoney(totalAmount);
    $("kpiEarningsToday").textContent = `Hôm nay: ${formatMoney(todayAmount)} · Tháng: ${formatMoney(monthAmount)}`;

    const validSheetRows = state.sheetRecords.filter(r => !/^link\s*đổi\s*câu$/i.test(String(r.targetUrl || "").trim()));
    const skipSheetRows = validSheetRows.filter(r => isSkipAnswerText(r.answer));
    const normalSheetRows = validSheetRows.length - skipSheetRows.length;

    $("kpiSheetSourceBadge").textContent = state.sheetSourceLabel;
    $("kpiSheetTotal").textContent = `${validSheetRows.length} câu`;
    $("kpiSheetBreakdown").textContent = `${normalSheetRows} câu chấm · ${skipSheetRows.length} câu Đổi`;
    $("tabCountSheet").textContent = String(validSheetRows.length + state.localLearnedRecords.length);
    $("tabCountHistory").textContent = String(state.questionHistory.length);

    const minD = Number(live?.delayMinSeconds || s.answerDelayMinSeconds || 10);
    const maxD = Number(live?.delayMaxSeconds || s.answerDelayMaxSeconds || 15);
    const f5Sec = Number(live?.refreshSeconds || s.refreshSeconds || 5);
    const f5On = live?.f5Enabled !== undefined ? live.f5Enabled : (s.enabled !== false);
    const autoOn = live?.autoAnswerEnabled !== undefined ? live.autoAnswerEnabled : (s.autoAnswerEnabled !== false);

    $("kpiDelayValue").textContent = `Delay ${minD}–${maxD}s`;
    $("kpiF5Foot").textContent = `F5: ${f5On ? `${f5Sec}s` : "TẮT"} · Tự trả lời: ${autoOn ? "BẬT" : "TẮT"}`;
    $("kpiModeBadge").textContent = s.remoteServerEnabled ? "Local + Hub" : "100% Độc lập";

    const btnSound = $("btnToggleSound");
    if (btnSound) {
      btnSound.textContent = state.soundEnabled ? "🔔 Âm báo HIT: BẬT" : "🔕 Âm báo HIT: TẮT";
    }

    if (currentStatus === "hit_available" && live?.at && live.at !== state.lastSoundAlertAt) {
      state.lastSoundAlertAt = live.at;
      playHitBeep();
    }
  }

  function renderQuickControls() {
    const activeEl = document.activeElement;
    if (activeEl && ["quickDelayMin", "quickDelayMax", "quickRefreshSec"].includes(activeEl.id)) return;
    const s = state.settings;
    const live = state.liveTabState;
    $("quickDelayMin").value = Number(live?.delayMinSeconds || s.answerDelayMinSeconds || 10);
    $("quickDelayMax").value = Number(live?.delayMaxSeconds || s.answerDelayMaxSeconds || 15);
    $("quickRefreshSec").value = Number(live?.refreshSeconds || s.refreshSeconds || 5);
    $("quickAutoAnswer").checked = live?.autoAnswerEnabled !== undefined ? live.autoAnswerEnabled : (s.autoAnswerEnabled !== false);
  }

  function renderLiveHitInspector() {
    const live = state.liveTabState;
    const box = $("hitInspectorBox");
    const badge = $("inspectorBadge");
    const msgEl = $("inspectorStatusMsg");
    const countdownBar = $("inspectorCountdownBar");
    const countdownLabel = $("inspectorCountdownLabel");
    const countdownTimer = $("inspectorCountdownTimer");
    const targetUrlEl = $("inspectorTargetUrl");
    const sheetMatchEl = $("inspectorSheetMatch");
    const optionsEl = $("inspectorOptionsList");

    if (!live) {
      box.className = "hit-inspector";
      badge.className = "badge badge-info";
      badge.textContent = "Chưa mở tab UHRS";
      msgEl.textContent = "Hãy bấm nút 'Mở Link Chuẩn (178599)' ở góc trên bên phải để bắt đầu canh HIT.";
      countdownBar.hidden = true;
      targetUrlEl.textContent = "Target URL: Chưa có";
      sheetMatchEl.textContent = "Kho Google Sheet đã sẵn sàng.";
      optionsEl.innerHTML = "";
      return;
    }

    const meta = statusMeta(live.status);
    badge.className = `badge ${meta.badge}`;
    badge.textContent = meta.label;
    box.className = `hit-inspector ${live.status === "hit_available" ? "active-hit" : ""}`;
    msgEl.textContent = live.message || "Đang theo dõi trang UHRS...";

    const targetUrl = live.targetUrl || "";
    targetUrlEl.textContent = targetUrl ? `Target URL: ${targetUrl}` : "Target URL: Không có (Đang ở màn hình chờ)";

    const remainingSec = live.autoAnswerSubmitAt && live.autoAnswerSubmitAt > Date.now()
      ? Math.max(1, Math.ceil((live.autoAnswerSubmitAt - Date.now()) / 1000))
      : 0;

    if (remainingSec > 0) {
      countdownBar.hidden = false;
      countdownLabel.textContent = `⏳ Đã chọn: "${live.autoAnswerSelected || "Đáp án"}" · Đang giữ Delay trước khi Submit/Đổi câu`;
      countdownTimer.textContent = `Còn ${remainingSec}s`;
    } else {
      countdownBar.hidden = true;
    }

    if (targetUrl && window.UHRSWatcherAnswerMemory) {
      const combined = [...state.localLearnedRecords, ...state.sheetRecords];
      const idx = window.UHRSWatcherAnswerMemory.createIndex(combined);
      const lookup = window.UHRSWatcherAnswerMemory.lookup(idx, targetUrl);
      if (lookup?.status === "matched" && lookup.record) {
        const isSkip = isSkipAnswerText(lookup.record.answer);
        sheetMatchEl.innerHTML = isSkip
          ? `🔀 <b style="color:#fde68a">Khớp Google Sheet (Dòng #${lookup.record.rowNumber || "?"}): ĐỔI CÂU</b> — Chờ hết Delay sẽ tự chuyển sang Link đổi câu.`
          : `✅ <b style="color:#6ee7b7">Khớp Google Sheet (Dòng #${lookup.record.rowNumber || "?"}): ${escapeHtml(lookup.record.answer)}</b>`;
      } else {
        sheetMatchEl.innerHTML = `⚠️ <span style="color:#fde68a">URL này chưa có sẵn trong Google Sheet.</span>`;
      }
    } else if (live.lastAutoAnswerResult?.answer) {
      sheetMatchEl.textContent = `Kết quả xử lý gần nhất: ${live.lastAutoAnswerResult.answer} (${live.lastAutoAnswerResult.reason || ""})`;
    } else {
      sheetMatchEl.textContent = `Kho Google Sheet (${state.sheetRecords.length} dòng) đang trực chiến.`;
    }

    const opts = live.questionExtraction?.options || [
      { id: "A", text: "Not Junk" },
      { id: "B", text: "Error / Page not found / No results" },
      { id: "C", text: "Site unreachable" },
      { id: "D", text: "Low or no content" },
      { id: "E", text: "Mostly ads / spam" },
      { id: "F", text: "Auto redirect" },
      { id: "G", text: "Can't judge" }
    ];
    const selectedNorm = String(live.autoAnswerSelected || "").trim().toLowerCase();
    optionsEl.innerHTML = opts.map(opt => {
      const text = opt.text || opt.label || "";
      const isSel = selectedNorm && text.toLowerCase().includes(selectedNorm);
      return `<span class="option-pill ${isSel ? "selected" : ""}">${escapeHtml(text)}</span>`;
    }).join("");
  }

  function buildUnifiedProfilesList() {
    const map = new Map();
    const s = state.settings;

    // 1. Active tabs from storage
    for (const tab of Object.values(state.activeStatesByTab)) {
      const name = String(tab.adsPowerProfile || tab.profile || s.adsPowerProfile || s.profile || "Current Profile").trim();
      const key = name.toLowerCase();
      map.set(key, {
        name,
        profileId: tab.adsPowerProfileId || s.adsPowerProfileId || "",
        userName: tab.userName || s.userName || "",
        proxyName: tab.proxyName || s.proxyName || "",
        ip: tab.networkIp || tab.adsPowerProxyIp || s.networkIp || s.adsPowerProxyIp || "",
        country: [tab.networkCountry || tab.adsPowerProxyCountry, tab.networkCity || tab.adsPowerProxyCity].filter(Boolean).join(", "),
        status: tab.status || "idle",
        message: tab.message || "",
        targetUrl: tab.targetUrl || "",
        f5Enabled: tab.f5Enabled !== false,
        refreshSeconds: tab.refreshSeconds || s.refreshSeconds || 5,
        delayLabel: `${tab.delayMinSeconds || s.answerDelayMinSeconds || 10}–${tab.delayMaxSeconds || s.answerDelayMaxSeconds || 15}s`,
        lastSeenAt: tab.at || new Date().toISOString(),
        isActive: true,
        completedCount: 0,
        skippedCount: 0,
        rejectedCount: 0,
        totalEarnings: 0
      });
    }

    // 2. Profile registry stats
    for (const reg of Object.values(state.profileRegistry)) {
      const name = String(reg.adsPowerProfile || reg.profile || "Default").trim();
      const key = name.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        existing.completedCount += Number(reg.completedCount || 0);
        existing.skippedCount += Number(reg.skippedCount || 0);
        existing.rejectedCount += Number(reg.rejectedCount || 0);
        existing.totalEarnings += Number(reg.totalEarnings || 0);
        if (!existing.ip) existing.ip = reg.networkIp || "";
        if (!existing.country) existing.country = reg.networkCountry || "";
        if (!existing.proxyName) existing.proxyName = reg.proxyName || "";
      } else {
        const isRecent = reg.lastSeenAt && Date.now() - Date.parse(reg.lastSeenAt) < 15 * 60 * 1000;
        map.set(key, {
          name,
          profileId: reg.adsPowerProfileId || "",
          userName: reg.userName || "",
          proxyName: reg.proxyName || "",
          ip: reg.networkIp || "",
          country: [reg.networkCountry, reg.networkCity].filter(Boolean).join(", "),
          status: reg.status || "idle",
          message: reg.message || "",
          targetUrl: reg.targetUrl || "",
          f5Enabled: true,
          refreshSeconds: s.refreshSeconds || 5,
          delayLabel: `${s.answerDelayMinSeconds || 10}–${s.answerDelayMaxSeconds || 15}s`,
          lastSeenAt: reg.lastSeenAt || "",
          isActive: Boolean(isRecent),
          completedCount: Number(reg.completedCount || 0),
          skippedCount: Number(reg.skippedCount || 0),
          rejectedCount: Number(reg.rejectedCount || 0),
          totalEarnings: Number(reg.totalEarnings || 0)
        });
      }
    }

    // 3. AdsPower Local API profiles
    for (const ap of state.adsPowerProfiles) {
      const name = String(ap.profileName || ap.profileId || "").trim();
      if (!name) continue;
      const key = name.toLowerCase();
      const existing = map.get(key);
      if (existing) {
        if (!existing.profileId) existing.profileId = ap.profileId || "";
        if (!existing.proxyName) existing.proxyName = ap.proxyName || "";
        if (!existing.ip) existing.ip = ap.proxyIp || "";
        if (!existing.country) existing.country = ap.proxyCountry || "";
      } else {
        map.set(key, {
          name,
          profileId: ap.profileId || "",
          userName: ap.userName || "",
          proxyName: ap.proxyName || "",
          ip: ap.proxyIp || "",
          country: ap.proxyCountry || "",
          status: "offline",
          message: "Đã đồng bộ từ AdsPower Local API (Chưa mở tab UHRS)",
          targetUrl: "",
          f5Enabled: false,
          refreshSeconds: s.refreshSeconds || 5,
          delayLabel: `${s.answerDelayMinSeconds || 10}–${s.answerDelayMaxSeconds || 15}s`,
          lastSeenAt: "",
          isActive: false,
          completedCount: 0,
          skippedCount: 0,
          rejectedCount: 0,
          totalEarnings: 0
        });
      }
    }

    if (map.size === 0) {
      const fallbackName = s.adsPowerProfile || s.profile || "Profile Hiện Tại";
      map.set("default", {
        name: fallbackName,
        profileId: s.adsPowerProfileId || "",
        userName: s.userName || "",
        proxyName: s.proxyName || "",
        ip: s.networkIp || s.adsPowerProxyIp || "Đang nhận diện",
        country: s.networkCountry || s.adsPowerProxyCountry || "",
        status: "idle",
        message: "Bấm 'Mở Link Chuẩn (178599)' để bắt đầu phiên làm việc.",
        targetUrl: "",
        f5Enabled: s.enabled !== false,
        refreshSeconds: s.refreshSeconds || 5,
        delayLabel: `${s.answerDelayMinSeconds || 10}–${s.answerDelayMaxSeconds || 15}s`,
        lastSeenAt: new Date().toISOString(),
        isActive: true,
        completedCount: 0,
        skippedCount: 0,
        rejectedCount: 0,
        totalEarnings: 0
      });
    }

    // Deduplicate placeholder "Unknown" / "Default" when a real named profile exists
    const namedEntries = Array.from(map.values()).filter(
      item => !/^(?:unknown|default|current profile)$/i.test(String(item.name || "").trim())
    );
    if (namedEntries.length > 0) {
      const primaryNamed = namedEntries[0];
      for (const [k, item] of Array.from(map.entries())) {
        if (/^(?:unknown|default|current profile)$/i.test(String(item.name || "").trim())) {
          primaryNamed.completedCount += Number(item.completedCount || 0);
          primaryNamed.skippedCount += Number(item.skippedCount || 0);
          primaryNamed.rejectedCount += Number(item.rejectedCount || 0);
          primaryNamed.totalEarnings += Number(item.totalEarnings || 0);
          map.delete(k);
        }
      }
    }

    return Array.from(map.values()).sort((a, b) => {
      if (a.isActive !== b.isActive) return a.isActive ? -1 : 1;
      return String(a.name).localeCompare(String(b.name), undefined, { numeric: true });
    });
  }

  function renderProfilesSection() {
    const allProfiles = buildUnifiedProfilesList();
    $("tabCountProfiles").textContent = String(allProfiles.length);

    const filter = state.profileFilter;
    const q = state.profileSearch.trim().toLowerCase();

    const filtered = allProfiles.filter(item => {
      if (filter === "active" && !item.isActive) return false;
      if (filter === "hit" && item.status !== "hit_available") return false;
      if (filter === "waiting" && !["waiting_20m", "waiting"].includes(item.status)) return false;
      if (filter === "problem" && !["two_factor", "answer_rejected", "error"].includes(item.status)) return false;
      if (!q) return true;
      const hay = [item.name, item.profileId, item.proxyName, item.ip, item.country, item.message].join(" ").toLowerCase();
      return hay.includes(q);
    });

    const container = $("profilesContainer");
    if (!filtered.length) {
      container.innerHTML = `<div class="empty-box" style="grid-column:1/-1">Không có Profile nào khớp với bộ lọc hiện tại.</div>`;
      return;
    }

    container.innerHTML = filtered.slice(0, 120).map(p => {
      const meta = p.status === "offline"
        ? { label: "Chưa mở UHRS", badge: "", card: "" }
        : statusMeta(p.status);
      return `
        <article class="profile-card ${meta.card}">
          <div class="profile-card-head">
            <div class="profile-title">
              <span>${escapeHtml(p.name)}</span>
              ${p.profileId ? `<span class="mono" style="font-size:11px;color:var(--muted);font-weight:500">#${escapeHtml(p.profileId)}</span>` : ""}
            </div>
            <span class="badge ${meta.badge}">${escapeHtml(meta.label)}</span>
          </div>

          <div class="profile-meta">
            <div><b>IP:</b> ${escapeHtml(p.ip || "Chưa rõ")}</div>
            <div><b>Vùng:</b> ${escapeHtml(p.country || "Chưa rõ")}</div>
            <div><b>Proxy:</b> ${escapeHtml(p.proxyName || "Mặc định")}</div>
            <div><b>Cấu hình:</b> F5 ${p.f5Enabled ? `${p.refreshSeconds}s` : "Tắt"} · ${escapeHtml(p.delayLabel)}</div>
          </div>

          <div style="font-size:12.5px;color:var(--muted);overflow-wrap:anywhere">
            ${escapeHtml(p.message || "Đang sẵn sàng")}
          </div>

          ${p.targetUrl ? `<div class="mono" style="font-size:11.5px;color:var(--sky);overflow-wrap:anywhere">Target: ${escapeHtml(p.targetUrl)}</div>` : ""}

          <div class="profile-stats-row">
            <span>Submit: <b>${p.completedCount}</b> · Đổi: <b>${p.skippedCount}</b> · Lỗi: <b>${p.rejectedCount}</b></span>
            <span class="amount-positive">${formatMoney(p.totalEarnings)}</span>
          </div>
        </article>
      `;
    }).join("");
  }

  function renderSheetTable() {
    const tbody = $("sheetTableBody");
    if (!tbody) return;

    const combined = [
      ...state.localLearnedRecords.map((r, i) => ({
        rowNumber: `Local-${i + 1}`,
        targetUrl: r.targetUrl || "",
        answer: r.answer || "",
        notes: r.reason || r.notes || "Ghi nhớ bổ sung trên máy",
        source: "local-override"
      })),
      ...state.sheetRecords
    ];

    const q = state.sheetSearch.trim().toLowerCase();
    const filter = state.sheetFilter;

    const filtered = combined.filter(row => {
      const answer = String(row.answer || "").trim();
      const desc = describeSheetAnswer(answer).toLowerCase();
      if (filter === "skip" && !isSkipAnswerText(answer)) return false;
      if (filter === "not_junk" && !desc.includes("not junk")) return false;
      if (filter === "error" && !/error|not found|unreachable/i.test(desc)) return false;
      if (filter === "low_content" && !/low|content|ads|spam/i.test(desc)) return false;
      if (filter === "local" && row.source !== "local-override") return false;
      if (!q) return true;
      const hay = `${row.targetUrl || ""} ${row.matchUrl || ""} ${answer} ${desc} ${row.notes || ""}`.toLowerCase();
      return hay.includes(q);
    });

    if (!filtered.length) {
      tbody.innerHTML = `<tr><td colspan="5" class="empty-box">Không tìm thấy dòng đáp án nào khớp từ khóa.</td></tr>`;
      return;
    }

    tbody.innerHTML = filtered.slice(0, 600).map(row => {
      const isSkip = isSkipAnswerText(row.answer);
      const isLinkRow = /^link\s*đổi\s*câu$/i.test(String(row.targetUrl || "").trim());
      const badgeClass = isLinkRow
        ? "badge-info"
        : isSkip
          ? "badge-wait"
          : "badge-hit";
      const badgeLabel = isLinkRow
        ? `🔗 Link Đổi Câu: ${row.answer}`
        : isSkip
          ? `🔀 ${describeSheetAnswer(row.answer)}`
          : `✅ ${describeSheetAnswer(row.answer)}`;
      return `
        <tr>
          <td class="mono" style="color:var(--muted)">#${escapeHtml(row.rowNumber || "-")}</td>
          <td class="mono" style="overflow-wrap:anywhere;max-width:460px">${escapeHtml(row.targetUrl || row.matchUrl || "")}</td>
          <td><span class="badge ${badgeClass}">${escapeHtml(badgeLabel)}</span></td>
          <td style="color:var(--muted);font-size:12px">${escapeHtml(row.notes || row.source || "Google Sheet")}</td>
          <td>
            <button class="btn btn-sm" type="button" data-copy-url="${escapeHtml(row.targetUrl || row.answer || "")}">Copy</button>
          </td>
        </tr>
      `;
    }).join("");
  }

  function renderEarningsAndHistory() {
    const earningsBody = $("earningsTableBody");
    const historyBody = $("historyTableBody");
    if (!earningsBody || !historyBody) return;

    const todayStr = new Date().toISOString().slice(0, 10);
    const monthStr = todayStr.slice(0, 7);

    // Group by profile
    const byProfile = new Map();
    for (const p of buildUnifiedProfilesList()) {
      if (!p.isActive && p.completedCount === 0 && p.skippedCount === 0) continue;
      byProfile.set(p.name, {
        profile: p.name,
        proxyInfo: [p.proxyName, p.ip, p.country].filter(Boolean).join(" · ") || "Mặc định",
        completed: 0,
        skipped: 0,
        rejected: 0,
        todayAmount: 0,
        monthAmount: 0,
        totalAmount: 0
      });
    }

    for (const q of state.questionHistory) {
      const key = q.profile || "Default";
      if (!byProfile.has(key)) {
        byProfile.set(key, {
          profile: key,
          proxyInfo: [q.proxyName, q.networkIp, q.networkCountry].filter(Boolean).join(" · ") || "Mặc định",
          completed: 0,
          skipped: 0,
          rejected: 0,
          todayAmount: 0,
          monthAmount: 0,
          totalAmount: 0
        });
      }
      const entry = byProfile.get(key);
      if (q.status === "completed") {
        const amt = Number(q.reward || 0.025);
        entry.completed += 1;
        entry.totalAmount += amt;
        const d = String(q.at || "").slice(0, 10);
        if (d === todayStr) entry.todayAmount += amt;
        if (d.slice(0, 7) === monthStr) entry.monthAmount += amt;
      } else if (q.status === "skipped") {
        entry.skipped += 1;
      } else if (q.status === "rejected") {
        entry.rejected += 1;
      }
    }

    const rows = Array.from(byProfile.values());
    if (!rows.length) {
      earningsBody.innerHTML = `<tr><td colspan="8" class="empty-box">Chưa có dữ liệu làm bài. Khi tool tự động Submit hoặc Đổi câu, thống kê sẽ hiển thị tại đây.</td></tr>`;
    } else {
      earningsBody.innerHTML = rows.map(r => `
        <tr>
          <td><b>${escapeHtml(r.profile)}</b></td>
          <td style="color:var(--muted)">${escapeHtml(r.proxyInfo)}</td>
          <td><b>${r.completed}</b> câu</td>
          <td><b>${r.skipped}</b> câu</td>
          <td style="color:${r.rejected > 0 ? "#fda4af" : "var(--muted)"}">${r.rejected} câu</td>
          <td class="amount-positive">${formatMoney(r.todayAmount)}</td>
          <td class="amount-positive">${formatMoney(r.monthAmount)}</td>
          <td class="amount-positive">${formatMoney(r.totalAmount)}</td>
        </tr>
      `).join("");
    }

    // History table
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
            <td style="color:var(--muted);font-size:12px">${escapeHtml(formatTime(evt.at))}</td>
            <td><b>${escapeHtml(evt.profile || "Default")}</b></td>
            <td><span class="badge ${meta.badge}">${escapeHtml(meta.label)}</span></td>
            <td class="mono" style="overflow-wrap:anywhere">${escapeHtml(evt.targetUrl || evt.url || "")}</td>
            <td style="color:var(--muted)">${escapeHtml(evt.message || "")}</td>
            <td style="color:var(--muted)">${evt.confidence ? Math.round(Number(evt.confidence) * 100) + "%" : "-"}</td>
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
        ? `<span class="badge badge-hit">✅ Đã Submit</span>`
        : q.status === "skipped"
          ? `<span class="badge badge-wait">🔀 Đã Đổi câu</span>`
          : `<span class="badge badge-danger">❌ Bị từ chối</span>`;
      const delaySec = q.elapsedMs ? `${(Number(q.elapsedMs) / 1000).toFixed(1)}s` : "-";
      const rewardStr = q.status === "completed" ? ` · +${formatMoney(q.reward || 0.025)}` : "";
      return `
        <tr>
          <td style="color:var(--muted);font-size:12px">${escapeHtml(formatTime(q.at))}</td>
          <td><b>${escapeHtml(q.profile || "Default")}</b></td>
          <td>${badge}</td>
          <td class="mono" style="overflow-wrap:anywhere">${escapeHtml(q.targetUrl || q.question || "")}</td>
          <td><b>${escapeHtml(q.answer || "")}</b><div style="font-size:11.5px;color:var(--muted)">${escapeHtml(q.reason || q.source || "")}</div></td>
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
    $("setDelayMin").value = Number(s.answerDelayMinSeconds || 10);
    $("setDelayMax").value = Number(s.answerDelayMaxSeconds || 15);
    $("setRefreshSec").value = Number(s.refreshSeconds || 5);
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

  function saveSettingsObject(partial, toastMessage = "Đã lưu và áp dụng thiết lập!") {
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

  $("btnToggleSound")?.addEventListener("click", () => {
    state.soundEnabled = !state.soundEnabled;
    localStorage.setItem("uhrsDashSound", String(state.soundEnabled));
    renderKPIs();
    showToast(state.soundEnabled ? "Đã bật âm báo khi có HIT!" : "Đã tắt âm báo HIT.");
  });

  $("btnRefreshAll")?.addEventListener("click", async () => {
    await loadLocalExtensionState();
    await loadGoogleSheetRecords(true);
    await scanAdsPowerProfiles(false);
    showToast("Đã làm mới toàn bộ dữ liệu trực tiếp!");
  });

  $("btnHeaderOpenApp")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().primaryUrl));
  $("btnHeaderOpenSkip")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().skipUrl));
  $("btnOpenSkipGroup")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().skipUrl));
  $("btnOpenPrimaryApp")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().primaryUrl));
  $("btnOpenMarketplace")?.addEventListener("click", () => openOrNavigateUhrsUrl(getAppUrls().marketplaceUrl));

  $("btnCmdStartF5")?.addEventListener("click", () => {
    saveSettingsObject({ enabled: true }, "Đã bật Auto F5 canh HIT!");
    sendTabCommand("START_F5");
  });

  $("btnCmdStopF5")?.addEventListener("click", () => {
    saveSettingsObject({ enabled: false }, "Đã tạm dừng Auto F5.");
    sendTabCommand("STOP_F5");
  });

  $("btnCmdScanNow")?.addEventListener("click", () => {
    sendTabCommand("SCAN_NOW");
    showToast("Đã gửi lệnh quét trang UHRS ngay lập tức!");
  });

  $("btnCmdShowPanel")?.addEventListener("click", () => {
    sendTabCommand("SHOW_PANEL");
    showToast("Đã bật hiển thị bảng điều khiển nổi trên tab UHRS!");
  });

  $("btnSaveQuickConfig")?.addEventListener("click", () => {
    const minSec = Math.max(1, Math.min(120, Math.round(Number($("quickDelayMin").value) || 10)));
    const maxSec = Math.max(minSec, Math.min(120, Math.round(Number($("quickDelayMax").value) || 15)));
    const refreshSeconds = Math.max(5, Math.min(120, Math.round(Number($("quickRefreshSec").value) || 5)));
    const autoAnswerEnabled = $("quickAutoAnswer").checked;
    saveSettingsObject(
      {
        answerDelayMinSeconds: minSec,
        answerDelayMaxSeconds: maxSec,
        autoAnswerMinSubmitDelayMs: minSec * 1000,
        refreshSeconds,
        autoAnswerEnabled
      },
      `Đã áp dụng: Delay ${minSec}–${maxSec}s · F5 ${refreshSeconds}s · Auto ${autoAnswerEnabled ? "BẬT" : "TẮT"}`
    );
  });

  $("btnCopyTargetUrl")?.addEventListener("click", () => {
    const url = state.liveTabState?.targetUrl || "";
    if (!url) {
      showToast("Hiện chưa có Target URL để copy.");
      return;
    }
    navigator.clipboard?.writeText(url);
    showToast("Đã copy Target URL!");
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
    showToast("Đang đồng bộ trực tiếp từ Google Sheet...");
    await loadGoogleSheetRecords(true);
    showToast(`Đã đồng bộ ${state.sheetRecords.length} dòng từ Google Sheet!`);
  });

  $("sheetTableBody")?.addEventListener("click", event => {
    const btn = event.target.closest("button[data-copy-url]");
    if (!btn) return;
    const text = btn.dataset.copyUrl || "";
    navigator.clipboard?.writeText(text);
    showToast("Đã copy vào bộ nhớ tạm!");
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
      notes: notes || "Thêm trực tiếp từ Dashboard v3.0",
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
    showToast(`Đã lưu đáp án "${answer}" cho URL vào bộ nhớ máy!`);
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
        q.status === "completed" ? Number(q.reward || 0.025).toFixed(4) : "0",
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
    showToast("Đã xuất báo cáo CSV thành công!");
  });

  $("btnClearHistory")?.addEventListener("click", () => {
    if (!confirm("Bạn có chắc chắn muốn xóa lịch sử câu hỏi và sự kiện trên máy này?")) return;
    state.questionHistory = [];
    state.eventHistory = [];
    if (isExtensionEnv && globalThis.chrome?.runtime?.sendMessage) {
      chrome.runtime.sendMessage({ type: "clear_watcher_history" }, () => {
        renderKPIs();
        renderEarningsAndHistory();
        showToast("Đã xóa lịch sử làm bài!");
      });
    }
  });

  $("fullSettingsForm")?.addEventListener("submit", event => {
    event.preventDefault();
    const minSec = Math.max(1, Math.min(120, Math.round(Number($("setDelayMin").value) || 10)));
    const maxSec = Math.max(minSec, Math.min(120, Math.round(Number($("setDelayMax").value) || 15)));
    const refreshSeconds = Math.max(5, Math.min(120, Math.round(Number($("setRefreshSec").value) || 5)));
    const settleMs = Math.max(800, Math.min(5000, Math.round(Number($("setSettleMs").value) || 1500)));
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

    saveSettingsObject(updated, "Đã lưu toàn bộ cấu hình hệ thống v3.0!");
  });

  $("btnResetDefaults")?.addEventListener("click", () => {
    saveSettingsObject(
      {
        ...DEFAULT_SETTINGS,
        dashboardUrl: isExtensionEnv && chrome.runtime?.getURL ? chrome.runtime.getURL("dashboard.html") : "dashboard.html"
      },
      "Đã khôi phục cấu hình mặc định chuẩn!"
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
