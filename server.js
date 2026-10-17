const http = require("http");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 8790);
const EXT_DIR = fs.existsSync(path.resolve(__dirname, "../uhrs-hit-watcher-extension/dashboard.html"))
  ? path.resolve(__dirname, "../uhrs-hit-watcher-extension")
  : __dirname;
const WATCHER_STATUS_FILE = "C:\\Users\\Tafi\\.gemini\\antigravity\\brain\\f8126fb9-6434-4958-aeb4-e5abedff3084\\scratch\\watcher_status.json";
const HUB_CACHE_FILE = "C:\\Users\\Tafi\\.gemini\\antigravity\\brain\\f8126fb9-6434-4958-aeb4-e5abedff3084\\scratch\\hub_state_cache.json";

const hubState = {
  watcherSettings: {
    appId: "63766",
    skipTaskGroupId: "178599",
    sheetId: "1Px75lVqZHnwRuvwzA83YmVj_I0sLm9EbBS-mpG_GOL0",
    sheetGid: "1271800557",
    refreshSeconds: 8,
    answerDelayMinSeconds: 11,
    answerDelayMaxSeconds: 15,
    autoAnswerSettleMs: 1500,
    enabled: true,
    autoAnswerEnabled: true,
    stopOnNoHit: false,
    autoOpenTask: false
  },
  activeTabs: {},
  profiles: {},
  adsPowerProfiles: [],
  events: [],
  questions: [],
  queuedCommands: [],
  sheetCache: {
    records: [],
    fetchedAt: 0
  }
};

try {
  if (fs.existsSync(HUB_CACHE_FILE)) {
    const saved = JSON.parse(fs.readFileSync(HUB_CACHE_FILE, "utf8"));
    if (saved?.watcherSettings && typeof saved.watcherSettings === "object") {
      for (const k of [
        "appId", "skipTaskGroupId", "sheetId", "sheetGid",
        "refreshSeconds", "answerDelayMinSeconds", "answerDelayMaxSeconds",
        "autoAnswerSettleMs", "enabled", "autoAnswerEnabled", "stopOnNoHit", "autoOpenTask"
      ]) {
        if (saved.watcherSettings[k] !== undefined) {
          hubState.watcherSettings[k] = saved.watcherSettings[k];
        }
      }
    }
    if (saved?.profiles) hubState.profiles = { ...hubState.profiles, ...saved.profiles };
    if (Array.isArray(saved?.adsPowerProfiles)) hubState.adsPowerProfiles = saved.adsPowerProfiles;
  }
} catch {}

function saveHubStateCache() {
  try {
    fs.writeFileSync(
      HUB_CACHE_FILE,
      JSON.stringify({
        watcherSettings: hubState.watcherSettings,
        profiles: hubState.profiles,
        adsPowerProfiles: hubState.adsPowerProfiles
      }),
      "utf8"
    );
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

async function fetchLiveGoogleSheet(sheetId, sheetGid, force = false) {
  const now = Date.now();
  if (!force && hubState.sheetCache.records.length && now - hubState.sheetCache.fetchedAt < 60000) {
    return hubState.sheetCache.records;
  }
  try {
    const csvUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/export?format=csv&gid=${encodeURIComponent(sheetGid)}`;
    const res = await fetch(csvUrl, { cache: "no-store" });
    if (res.ok) {
      const text = await res.text();
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
        hubState.sheetCache = { records, fetchedAt: now };
        return records;
      }
    }
  } catch {}

  try {
    const bundledPath = path.join(EXT_DIR, "answer-memory.json");
    if (fs.existsSync(bundledPath)) {
      const bundled = JSON.parse(fs.readFileSync(bundledPath, "utf8"));
      if (Array.isArray(bundled?.records)) {
        return bundled.records;
      }
    }
  } catch {}
  return [];
}

function mergeAdsPowerProfilesList(incoming) {
  const byName = new Map();
  for (const item of hubState.adsPowerProfiles || []) {
    const key = String(item.profileName || item.profileId || "").trim();
    if (key && !/^(?:Unknown|Default)$/i.test(key)) byName.set(key, item);
  }
  for (const item of incoming || []) {
    const key = String(item.profileName || item.profileId || "").trim();
    if (!key || /^(?:Unknown|Default)$/i.test(key)) continue;
    byName.set(key, { ...(byName.get(key) || {}), ...item, profileName: key });
  }
  hubState.adsPowerProfiles = Array.from(byName.values());
  return hubState.adsPowerProfiles;
}

async function syncAdsPowerLocalApi(apiUrl = "http://127.0.0.1:50325") {
  try {
    const cleanUrl = String(apiUrl || "http://127.0.0.1:50325").replace(/\/+$/, "");
    const headers = { Authorization: "Bearer e1b667df828ab6f9466fe9e3e6338ca3008fabe53027fa82" };
    const res = await fetch(`${cleanUrl}/api/v1/user/list?page=1&page_size=100`, { headers });
    if (!res.ok) return hubState.adsPowerProfiles;
    const data = await res.json();
    const list = Array.isArray(data?.data?.list) ? data.data.list : [];
    const mapped = list.map(item => {
      const ip = String(item.ip || "");
      const country = String(item.ip_country || item.country || "").toUpperCase();
      return {
        profileId: String(item.user_id || ""),
        serialNumber: String(item.serial_number || ""),
        profileName: String(item.name || item.serial_number || item.user_id || "Profile"),
        groupName: String(item.group_name || ""),
        proxyIp: ip,
        proxyCountry: country,
        proxyName: item.user_proxy_config?.proxy_host
          ? `${item.user_proxy_config.proxy_type || "proxy"}://${item.user_proxy_config.proxy_host}:${item.user_proxy_config.proxy_port || ""}`
          : (ip ? `${ip}${country ? ` (${country})` : ""}` : "")
      };
    });
    if (mapped.length) {
      mergeAdsPowerProfilesList(mapped);
      for (const p of mapped) {
        const name = p.profileName;
        if (!name) continue;
        if (!hubState.profiles[name]) {
          hubState.profiles[name] = {
            profileName: name,
            profileId: p.profileId,
            serialNumber: p.serialNumber,
            proxyName: p.proxyName || "",
            networkIp: p.proxyIp || "",
            networkCountry: p.proxyCountry || "",
            status: "waiting_20m",
            message: "Đang treo F5 canh HIT trên UHRS (63766)",
            lastSeenAt: new Date().toISOString(),
            completedCount: 0,
            skippedCount: 0,
            rejectedCount: 0,
            totalEarnings: 0
          };
        }
      }
    }
    return hubState.adsPowerProfiles;
  } catch {
    return hubState.adsPowerProfiles;
  }
}

function syncFromLocalWatcherStatus() {
  try {
    if (!fs.existsSync(WATCHER_STATUS_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(WATCHER_STATUS_FILE, "utf8"));
    if (!raw || typeof raw !== "object") return;
    const pi = raw.pageInfo || {};
    const profileName = "JP29";
    const tabKey = `${profileName}::live-40`;
    const existingTab = hubState.activeTabs[tabKey];
    const nowIso = raw.updatedAt || raw.at || new Date().toISOString();
    const rawTime = Date.parse(nowIso) || Date.now();
    const existingTime = Date.parse(existingTab?.lastSeenAt || "") || 0;

    const prevJp29 = hubState.profiles[profileName];
    const isF5Paused = prevJp29?.f5Enabled === false || pi.f5Enabled === false;
    const rawStatus = (pi.status && pi.status !== "unknown")
      ? pi.status
      : (raw.detectedStatus || (pi.reduxJudging?.missingHitsReason === 6 ? "waiting_20m" : "waiting"));
    const status = isF5Paused && ["waiting_20m", "waiting", "idle"].includes(rawStatus)
      ? "idle"
      : rawStatus;
    const message = isF5Paused && status === "idle"
      ? "Đã tạm dừng Auto F5 (Đang nghỉ)"
      : (pi.message || raw.detectedReason || "Đang treo F5 canh HIT trên UHRS (63766)");

    if (!existingTab || rawTime >= existingTime - 5000) {
      hubState.activeTabs[tabKey] = {
        ...(existingTab || {}),
        profile: profileName,
        adsPowerProfile: profileName,
        adsPowerSerial: "40",
        tabId: "live-40",
        status,
        message,
        url: pi.url || raw.pageUrl || "https://www.uhrs.ai/marketplace/app/63766",
        title: raw.pageTitle || "UHRS — HitApp 63766",
        targetUrl: pi.targetUrl || raw.targetUrl || "",
        questionText: raw.questionText || "",
        matchedAnswer: pi.autoAnswerSelected || raw.sheetMatch?.answer || "",
        networkIp: "139.190.145.67",
        networkCountry: "JP",
        proxyName: "139.190.145.67 (JP)",
        f5Enabled: !isF5Paused,
        f5Active: !isF5Paused,
        autoAnswerEnabled: hubState.watcherSettings.autoAnswerEnabled !== false,
        at: nowIso,
        lastSeenAt: nowIso
      };
    }

    if (!hubState.profiles[profileName]) {
      hubState.profiles[profileName] = {
        profileName,
        proxyName: "139.190.145.67 (JP)",
        networkIp: "139.190.145.67",
        networkCountry: "JP",
        status,
        message,
        f5Enabled: !isF5Paused,
        lastSeenAt: nowIso,
        completedCount: Number(raw.hitsDetected || 0),
        skippedCount: Number(raw.skippedQuestionCount || 0),
        rejectedCount: 0,
        totalEarnings: Number(raw.hitsDetected || 0) * 0.03
      };
    } else {
      hubState.profiles[profileName].status = status;
      hubState.profiles[profileName].message = message;
      hubState.profiles[profileName].lastSeenAt = nowIso;
    }
  } catch {}
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-allow-private-network": "true"
  };
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    ...corsHeaders()
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req) {
  return new Promise(resolve => {
    let raw = "";
    req.on("data", chunk => {
      raw += chunk;
      if (raw.length > 2 * 1024 * 1024) req.destroy();
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
    req.on("error", () => resolve({}));
  });
}

function serveStaticFile(res, filename, contentType) {
  const filePath = path.join(EXT_DIR, filename);
  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8", ...corsHeaders() });
    res.end("Not found");
    return;
  }
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": "no-store",
    ...corsHeaders()
  });
  fs.createReadStream(filePath).pipe(res);
}

async function requestHandler(req, res) {
  if (req.method === "OPTIONS") {
    res.writeHead(204, corsHeaders());
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = parsedUrl.pathname;

  if (req.method === "GET" && (pathname === "/" || pathname === "/index.html" || pathname === "/dashboard.html")) {
    serveStaticFile(res, "dashboard.html", "text/html; charset=utf-8");
    return;
  }
  if (req.method === "GET" && pathname === "/dashboard.js") {
    serveStaticFile(res, "dashboard.js", "application/javascript; charset=utf-8");
    return;
  }
  if (req.method === "GET" && pathname === "/answer-memory.js") {
    serveStaticFile(res, "answer-memory.js", "application/javascript; charset=utf-8");
    return;
  }
  if (req.method === "GET" && pathname === "/answer-memory.json") {
    serveStaticFile(res, "answer-memory.json", "application/json; charset=utf-8");
    return;
  }

  if (req.method === "GET" && pathname === "/api/health") {
    sendJson(res, 200, { ok: true, version: "3.0.0", status: "running" });
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    syncFromLocalWatcherStatus();
    sendJson(res, 200, {
      ok: true,
      watcherSettings: hubState.watcherSettings,
      activeTabs: hubState.activeTabs,
      profiles: Object.values(hubState.profiles),
      adsPowerProfiles: hubState.adsPowerProfiles,
      events: hubState.events,
      questions: hubState.questions
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/sheet") {
    const rawSheetId = parsedUrl.searchParams.get("sheetId") || hubState.watcherSettings.sheetId;
    const sheetId = rawSheetId === "1YsI4jFvSIqbsGn6aXCfi84g5jNP3hqcQeWgsrKwk_ys"
      ? "1Px75lVqZHnwRuvwzA83YmVj_I0sLm9EbBS-mpG_GOL0"
      : rawSheetId;
    const sheetGid = parsedUrl.searchParams.get("sheetGid") || hubState.watcherSettings.sheetGid;
    const force = parsedUrl.searchParams.get("force") === "1";
    const records = await fetchLiveGoogleSheet(sheetId, sheetGid, force);
    sendJson(res, 200, {
      ok: true,
      sourceLabel: "Live Google Sheet (Phú Ngao Tool)",
      count: records.length,
      records
    });
    return;
  }

  if (req.method === "POST" && pathname === "/api/memory/recheck") {
    sendJson(res, 200, {
      ok: true,
      status: "sheet_miss_default_1",
      verifiedAnswer: "Not Junk",
      confidence: 1,
      provider: "phu-ngao-default-1"
    });
    return;
  }

  if (req.method === "GET" && pathname === "/api/adspower/scan") {
    const apiUrl = parsedUrl.searchParams.get("apiUrl") || "http://local.adspower.net:50325";
    const profiles = await syncAdsPowerLocalApi(apiUrl);
    sendJson(res, 200, { ok: true, profiles });
    return;
  }

  if (req.method === "GET" && pathname === "/api/settings") {
    sendJson(res, 200, { ok: true, settings: hubState.watcherSettings });
    return;
  }

  if (req.method === "POST" && pathname === "/api/settings") {
    const body = await readJsonBody(req);
    const allowedKeys = [
      "appId", "skipTaskGroupId", "sheetId", "sheetGid",
      "refreshSeconds", "answerDelayMinSeconds", "answerDelayMaxSeconds",
      "autoAnswerSettleMs", "enabled", "autoAnswerEnabled", "stopOnNoHit", "autoOpenTask"
    ];
    for (const k of allowedKeys) {
      if (body[k] !== undefined) {
        hubState.watcherSettings[k] = body[k];
      }
    }
    const nowMs = Date.now();
    const nowIso = new Date().toISOString();
    if (body.answerDelayMinSeconds || body.answerDelayMaxSeconds) {
      hubState.queuedCommands.push({
        id: `cmd-${nowMs}-delay`,
        at: nowMs,
        command: "SET_DELAY",
        minSec: hubState.watcherSettings.answerDelayMinSeconds,
        maxSec: hubState.watcherSettings.answerDelayMaxSeconds
      });
    }
    if (body.refreshSeconds) {
      hubState.queuedCommands.push({
        id: `cmd-${nowMs}-refresh`,
        at: nowMs,
        command: "SET_REFRESH",
        refreshSeconds: hubState.watcherSettings.refreshSeconds
      });
    }
    if (typeof body.autoAnswerEnabled === "boolean") {
      hubState.queuedCommands.push({
        id: `cmd-${nowMs}-autoanswer`,
        at: nowMs,
        command: "SET_AUTO_ANSWER",
        autoAnswerEnabled: Boolean(body.autoAnswerEnabled)
      });
    }
    if (typeof body.enabled === "boolean") {
      const isStart = Boolean(body.enabled);
      hubState.queuedCommands.push({
        id: `cmd-${nowMs}-f5`,
        at: nowMs,
        command: isStart ? "START_F5" : "STOP_F5"
      });
      const nextStatus = isStart ? "waiting_20m" : "idle";
      const nextMsg = isStart
        ? "Đang treo F5 canh HIT trên UHRS (63766)"
        : "Đã tạm dừng Auto F5 (Đang nghỉ)";
      for (const p of Object.values(hubState.profiles)) {
        p.f5Enabled = isStart;
        if (["waiting_20m", "waiting", "idle", "watcher_started", "offline"].includes(p.status || "")) {
          p.status = nextStatus;
          p.message = nextMsg;
          p.lastSeenAt = nowIso;
        }
      }
      for (const t of Object.values(hubState.activeTabs)) {
        t.f5Enabled = isStart;
        t.f5Active = isStart;
        if (["waiting_20m", "waiting", "idle", "watcher_started", "offline"].includes(t.status || "")) {
          t.status = nextStatus;
          t.message = nextMsg;
          t.at = nowIso;
          t.lastSeenAt = nowIso;
        }
      }
    }
    saveHubStateCache();
    sendJson(res, 200, { ok: true, settings: hubState.watcherSettings });
    return;
  }

  if (req.method === "POST" && pathname === "/api/action") {
    const payload = await readJsonBody(req);
    const nowIso = new Date().toISOString();
    const rawProf = String(payload.adsPowerProfile || payload.profile || "").trim();
    const profileName = (!rawProf || /^(?:Unknown|Default)$/i.test(rawProf)) ? "JP29" : rawProf;
    const tabId = String(payload.tabId || "tab-main").trim();
    const tabKey = `${profileName}::${tabId}`;

    for (const k of Object.keys(hubState.activeTabs)) {
      if (k.startsWith(`${profileName}::`) && k !== tabKey) {
        delete hubState.activeTabs[k];
      }
    }

    const prevProf = hubState.profiles[profileName] || {};
    const curF5 = typeof payload.f5Enabled === "boolean"
      ? payload.f5Enabled
      : (typeof prevProf.f5Enabled === "boolean" ? prevProf.f5Enabled : true);
    const effStatus = !curF5 && ["waiting_20m", "waiting", "idle", "watcher_started"].includes(payload.status || "")
      ? "idle"
      : (payload.status || prevProf.status || "idle");
    const effMessage = !curF5 && effStatus === "idle"
      ? "Đã tạm dừng Auto F5 (Đang nghỉ)"
      : (payload.message || prevProf.message || "");

    hubState.activeTabs[tabKey] = {
      ...payload,
      profile: profileName,
      adsPowerProfile: profileName,
      tabId,
      status: effStatus,
      message: effMessage,
      f5Enabled: curF5,
      f5Active: curF5,
      at: nowIso,
      lastSeenAt: nowIso
    };

    let isCompleted = false;
    let isSkipped = false;
    let isRejected = false;
    let reward = 0;

    if (payload.questionRecord && typeof payload.questionRecord === "object") {
      const qr = payload.questionRecord;
      const rs = String(qr.resultStatus || qr.status || "");
      isSkipped = rs === "changed_question" || /đổi\s*câu/i.test(String(qr.answer || ""));
      isRejected = Boolean(qr.rejected) || payload.status === "answer_rejected";
      isCompleted = (qr.status === "completed" || qr.status === "manual_completed") && !isSkipped && !isRejected;
      reward = isCompleted ? 0.03 : 0;

      hubState.questions = [
        {
          id: qr.id || `q-${Date.now()}`,
          at: nowIso,
          profile: profileName,
          proxyName: payload.proxyName || "",
          networkIp: payload.networkIp || payload.adsPowerProxyIp || "",
          networkCountry: payload.networkCountry || payload.adsPowerProxyCountry || "",
          targetUrl: payload.targetUrl || qr.finalUrl || "",
          answer: qr.answer || "",
          status: isSkipped ? "skipped" : (isRejected ? "rejected" : (isCompleted ? "completed" : "failed")),
          elapsedMs: Number(qr.elapsedMs || 0),
          reason: qr.reason || "",
          reward
        },
        ...hubState.questions
      ].slice(0, 500);
    }

    const netIp = payload.networkIp || payload.adsPowerProxyIp || prevProf.networkIp || "";
    const netCountry = payload.networkCountry || payload.adsPowerProxyCountry || prevProf.networkCountry || "";
    const proxyNm = payload.proxyName || prevProf.proxyName || (netIp ? `${netIp}${netCountry ? ` (${netCountry})` : ""}` : "");

    hubState.profiles[profileName] = {
      profileName,
      profileId: payload.adsPowerProfileId || prevProf.profileId || "",
      serialNumber: payload.adsPowerSerial || prevProf.serialNumber || "",
      proxyName: proxyNm,
      networkIp: netIp,
      networkCountry: netCountry,
      status: effStatus,
      message: effMessage,
      f5Enabled: curF5,
      lastSeenAt: nowIso,
      completedCount: Number(prevProf.completedCount || 0) + (isCompleted ? 1 : 0),
      skippedCount: Number(prevProf.skippedCount || 0) + (isSkipped ? 1 : 0),
      rejectedCount: Number(prevProf.rejectedCount || 0) + (isRejected ? 1 : 0),
      totalEarnings: Number(prevProf.totalEarnings || 0) + reward
    };

    mergeAdsPowerProfilesList([
      {
        profileName,
        profileId: payload.adsPowerProfileId || prevProf.profileId || "",
        serialNumber: payload.adsPowerSerial || prevProf.serialNumber || "",
        proxyIp: netIp,
        proxyCountry: netCountry,
        proxyName: proxyNm
      }
    ]);

    hubState.events = [
      {
        at: nowIso,
        profile: profileName,
        status: effStatus,
        message: effMessage,
        targetUrl: payload.targetUrl || "",
        url: payload.url || "",
        confidence: payload.confidence
      },
      ...hubState.events
    ].slice(0, 250);

    saveHubStateCache();
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/commands") {
    const nowMs = Date.now();
    hubState.queuedCommands = (hubState.queuedCommands || []).filter(c => nowMs - Number(c.at || nowMs) < 25000);
    sendJson(res, 200, { ok: true, commands: hubState.queuedCommands });
    return;
  }

  if (req.method === "POST" && pathname === "/api/command") {
    const body = await readJsonBody(req);
    if (body.command) {
      const nowMs = Date.now();
      const nowIso = new Date().toISOString();
      hubState.queuedCommands = (hubState.queuedCommands || []).filter(c => nowMs - Number(c.at || nowMs) < 25000);
      hubState.queuedCommands.push({
        id: body.id || `cmd-${nowMs}-${Math.random().toString(16).slice(2, 6)}`,
        at: nowMs,
        ...body
      });
      const targetProf = String(body.profile || "").trim();
      if (body.command === "START_F5" || body.command === "STOP_F5") {
        const isStart = body.command === "START_F5";
        if (!targetProf) hubState.watcherSettings.enabled = isStart;
        const nextStatus = isStart ? "waiting_20m" : "idle";
        const nextMsg = isStart
          ? "Đang treo F5 canh HIT trên UHRS (63766)"
          : "Đã tạm dừng Auto F5 (Đang nghỉ)";
        for (const [k, p] of Object.entries(hubState.profiles)) {
          if (!targetProf || k.toLowerCase() === targetProf.toLowerCase()) {
            p.f5Enabled = isStart;
            if (["waiting_20m", "waiting", "idle", "watcher_started", "offline"].includes(p.status || "")) {
              p.status = nextStatus;
              p.message = nextMsg;
              p.lastSeenAt = nowIso;
            }
          }
        }
        for (const t of Object.values(hubState.activeTabs)) {
          const tProf = String(t.adsPowerProfile || t.profile || "").trim();
          if (!targetProf || tProf.toLowerCase() === targetProf.toLowerCase()) {
            t.f5Enabled = isStart;
            t.f5Active = isStart;
            if (["waiting_20m", "waiting", "idle", "watcher_started", "offline"].includes(t.status || "")) {
              t.status = nextStatus;
              t.message = nextMsg;
              t.at = nowIso;
              t.lastSeenAt = nowIso;
            }
          }
        }
        saveHubStateCache();
      } else if (body.command === "RELOAD_TAB" && targetProf) {
        for (const [k, p] of Object.entries(hubState.profiles)) {
          if (k.toLowerCase() === targetProf.toLowerCase()) {
            p.message = "Đang tải lại trang UHRS (Reload)...";
            p.lastSeenAt = nowIso;
          }
        }
        for (const t of Object.values(hubState.activeTabs)) {
          const tProf = String(t.adsPowerProfile || t.profile || "").trim();
          if (tProf.toLowerCase() === targetProf.toLowerCase()) {
            t.message = "Đang tải lại trang UHRS (Reload)...";
            t.at = nowIso;
            t.lastSeenAt = nowIso;
          }
        }
      }
    }
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === "POST" && pathname === "/api/adspower/profiles") {
    const body = await readJsonBody(req);
    const list = Array.isArray(body.profiles) ? body.profiles : [];
    mergeAdsPowerProfilesList(list);
    for (const p of list) {
      const name = String(p.profileName || p.profileId || "").trim();
      if (!name || /^(?:Unknown|Default)$/i.test(name)) continue;
      if (!hubState.profiles[name]) {
        hubState.profiles[name] = {
          profileName: name,
          profileId: p.profileId || "",
          serialNumber: p.serialNumber || "",
          proxyName: p.proxyName || "",
          networkIp: p.proxyIp || "",
          networkCountry: p.proxyCountry || "",
          status: "waiting_20m",
          message: "Đang treo F5 canh HIT trên UHRS (63766)",
          lastSeenAt: new Date().toISOString(),
          completedCount: 0,
          skippedCount: 0,
          rejectedCount: 0,
          totalEarnings: 0
        };
      }
    }
    saveHubStateCache();
    sendJson(res, 200, { ok: true });
    return;
  }

  sendJson(res, 404, { ok: false, error: "Not found" });
}

module.exports = requestHandler;

if (require.main === module) {
  syncFromLocalWatcherStatus();
  syncAdsPowerLocalApi();
  fetchLiveGoogleSheet(hubState.watcherSettings.sheetId, hubState.watcherSettings.sheetGid, true);
  setInterval(syncFromLocalWatcherStatus, 4000);
  setInterval(() => syncAdsPowerLocalApi(), 30000);

  const server = http.createServer(requestHandler);
  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[UHRS Control Center v3.0] Hub Server running at http://127.0.0.1:${PORT}/`);
  });
}
