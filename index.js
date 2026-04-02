/**
 * StreamBridge – Emby → Stremio addon
 * Full Express server with parameterised manifest + stream routes
 * User data is embedded in the URL path as a base64-url string.
 */

const crypto       = require("crypto");
const express      = require("express");
const path         = require("path");
const cors         = require("cors");
const rateLimit    = require("express-rate-limit");
const axios        = require("axios");
const embyClient   = require("./lib/embyClient");
const { redactServerUrl } = require("./lib/redact");
const { version } = require("./package.json");
// JELLYFIN: Jellyfin client import commented out for future Jellyfin support
// const jellyfinClient = require("./lib/jellyfinClient");
require("dotenv").config();

const PORT = process.env.PORT || 7000;
const app  = express();

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

const embyAuthLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { err: "Too many attempts. Try again later." },
  standardHeaders: true,
  legacyHeaders: false
});

app.use(express.json({ limit: "2kb" }));

app.post("/api/get-emby-tokens", embyAuthLimiter, async (req, res) => {
  const serverUrl = typeof req.body?.serverUrl === "string" ? req.body.serverUrl.trim() : "";
  const username  = typeof req.body?.username === "string" ? req.body.username : "";
  const password  = typeof req.body?.password === "string" ? req.body.password : "";

  if (!serverUrl || !username) {
    console.warn("Auth: missing serverUrl or username");
    return res.status(400).json({ err: "serverUrl and username are required" });
  }

  const normalizedUrl = serverUrl.replace(/\/+$/, "");
  if (!normalizedUrl.startsWith("http://") && !normalizedUrl.startsWith("https://")) {
    console.warn("Auth: invalid URL scheme (must be http:// or https://)");
    return res.status(400).json({ err: "URL must start with http:// or https://" });
  }

  const authUrl = `${normalizedUrl}/Users/AuthenticateByName`;
  try {
    const ax = await axios({
      method: "POST",
      url: authUrl,
      headers: {
        "Content-Type": "application/json",
        "X-Emby-Authorization": `MediaBrowser Client="StreamBridge", Device="WebHelper", DeviceId="webhelper", Version="${version}"`
      },
      data: { Username: username, Pw: password || "" },
      timeout: 5000,
      validateStatus: () => true
    });

    if (ax.status !== 200) {
      const msg = ax.data?.Message || ax.data?.message || `HTTP ${ax.status}`;
      console.warn("Auth failed:", redactServerUrl(normalizedUrl), "→", ax.status, msg);
      return res.status(400).json({ err: msg });
    }

    const data = ax.data;
    const userId = data?.User?.Id;
    const accessToken = data?.AccessToken;
    const serverId = data?.ServerId;

    if (!userId || !accessToken) {
      console.warn("Auth failed:", redactServerUrl(normalizedUrl), "→ invalid response (missing User.Id or AccessToken)");
      return res.status(502).json({ err: "Invalid response from server" });
    }

    return res.json({
      Id: userId,
      AccessToken: accessToken,
      ServerId: serverId != null ? serverId : undefined
    });
  } catch (e) {
    const msg = e?.response?.data?.Message || e?.response?.data?.message || e?.code || e?.message || "Request failed";
    const code = e?.code || (e?.response?.status ? `HTTP ${e.response.status}` : "");
    console.warn("Auth failed:", redactServerUrl(normalizedUrl), code ? "→" : "", code || "", msg);
    return res.status(502).json({ err: String(msg) });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// Helper: build a naked manifest (no user-specific data yet)
// ──────────────────────────────────────────────────────────────────────────
function baseManifest () {
  return {
    id      : "org.streambridge.embyresolver",
    version,
    name    : "StreamBridge: Emby to Stremio",
    description:
      "Stream media from your Emby server using IMDb/TMDB/Tvdb/Anidb IDs.",
    catalogs : [
      { type: "movie", id: "continue-watching-movies", name: "Continue Watching" },
      { type: "series", id: "continue-watching-series", name: "Continue Watching" }
    ],
    resources: [
      "catalog",
      { name: "stream",
        types: ["movie", "series"],
        idPrefixes: ["tt", "imdb:", "tmdb:"] }
    ],
    types: ["movie", "series"],
    behaviorHints: { configurable: true, configurationRequired: true },
    config: [
      { key: "serverUrl",   type: "text", title: "Server URL (Emby)",  required: true },
      { key: "userId",      type: "text", title: "User ID",     required: true },
      { key: "accessToken", type: "text", title: "Access Token", required: true }
    ]
  };
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: decode the cfg string into an object with defaults for backward compatibility
// ──────────────────────────────────────────────────────────────────────────
function decodeCfg(str) {
  const cfg = JSON.parse(Buffer.from(str, "base64url").toString("utf8"));

  // --- Validate required fields ---
  if (typeof cfg.serverUrl !== "string" || !cfg.serverUrl.trim()) {
    throw new Error("Invalid config: serverUrl must be a non-empty string");
  }
  if (!/^https?:\/\//i.test(cfg.serverUrl)) {
    throw new Error("Invalid config: serverUrl must start with http:// or https://");
  }
  if (typeof cfg.userId !== "string" || !cfg.userId.trim()) {
    throw new Error("Invalid config: userId must be a non-empty string");
  }
  if (typeof cfg.accessToken !== "string" || !cfg.accessToken.trim()) {
    throw new Error("Invalid config: accessToken must be a non-empty string");
  }

  cfg.serverUrl = cfg.serverUrl.replace(/\/+$/, '');

  // --- Validate optional fields (coerce invalid values to safe defaults) ---
  const VALID_SERVER_TYPES = ["emby", "jellyfin"];
  if (!VALID_SERVER_TYPES.includes(cfg.serverType)) cfg.serverType = "emby";
  if (typeof cfg.showServerName !== "boolean") cfg.showServerName = false;
  if (typeof cfg.streamName !== "string" || !cfg.streamName.trim()) {
    cfg.streamName = cfg.serverType === "jellyfin" ? "Jellyfin" : "Emby";
  }
  if (!Array.isArray(cfg.hideStreamTypes)) {
    cfg.hideStreamTypes = [];
  } else {
    cfg.hideStreamTypes = cfg.hideStreamTypes.filter(v => typeof v === "string");
  }
  if (cfg.includeSubtitles !== undefined && typeof cfg.includeSubtitles !== "boolean") {
    delete cfg.includeSubtitles;
  }

  // preferredLanguage: optional ISO 639-2/3 code (e.g. "eng", "fre", "ger")
  // Omit when unconfigured so old URLs keep working
  if (cfg.preferredLanguage !== undefined) {
    if (typeof cfg.preferredLanguage !== "string" || !/^[a-z]{2,3}$/i.test(cfg.preferredLanguage.trim())) {
      delete cfg.preferredLanguage;
    } else {
      cfg.preferredLanguage = cfg.preferredLanguage.trim().toLowerCase();
    }
  }

  return cfg;
}

// ──────────────────────────────────────────────────────────────────────────
// Helper: check if a stream should be filtered based on hideStreamTypes config
// Returns true if the stream matches ANY of the selected types to hide
// ──────────────────────────────────────────────────────────────────────────
function shouldFilterStream(stream, hideStreamTypes) {
  if (!hideStreamTypes || hideStreamTypes.length === 0) return false;
  
  const mediaInfo = stream.mediaInfo || {};
  const qualityTag = mediaInfo.qualityTag || '';
  const hdrTag = mediaInfo.hdrTag || '';
  
  // Check for 4K streams
  if (hideStreamTypes.includes('4K')) {
    if (qualityTag.includes('4K') || qualityTag === '2160p') {
      return true;
    }
  }
  
  // Check for 1080p streams
  if (hideStreamTypes.includes('1080p')) {
    if (qualityTag === '1080p') {
      return true;
    }
  }
  
  // Check for Dolby Vision (DV)
  if (hideStreamTypes.includes('DV')) {
    if (hdrTag === 'DV' || hdrTag === 'DolbyVision') {
      return true;
    }
  }
  
  // Check for HDR tags (any HDR variant: HDR10, HDR10+, HLG, DV, etc.)
  if (hideStreamTypes.includes('HDR')) {
    if (hdrTag && (hdrTag.includes('HDR') || hdrTag === 'HLG' || hdrTag === 'DV' || hdrTag === 'DolbyVision')) {
      return true;
    }
  }
  
  return false;
}   

// ──────────────────────────────────────────────────────────────────────────
// Parameterised MANIFEST route  →  /<cfg>/manifest.json
//     <cfg> is a base64-url-encoded JSON blob with {serverUrl,userId,accessToken}
// ──────────────────────────────────────────────────────────────────────────
app.get("/:cfg/manifest.json", (req, res) => {
  const cfgString = req.params.cfg;
  let cfg;
  try {
    cfg = decodeCfg(cfgString);    
  } catch (err) {
    console.error("[ERROR] Error decoding cfg in manifest route:", err.message);
    // SECURITY: Do not log cfgString as it contains sensitive user credentials (accessToken, userId, serverUrl)
    console.error("[ERROR] Failed to decode config (cfgString length:", cfgString?.length || 0, ")");
    return res.status(400).json({ err: "Bad config in URL", details: err.message });
  }

  const mf = baseManifest();

  if (!mf) {
    console.error("[FATAL] baseManifest() returned undefined. This is the cause of the error.");
    return res.status(500).json({ err: "Server error: Failed to generate base manifest object." });
  }

  mf.id += "." + cfgString.slice(0, 8); 

  // Conditionally show server name based on config (defaults to false - server name hidden by default)
  if (cfg.showServerName === true) {
    const serverHostname = (cfg && cfg.serverUrl) ? cfg.serverUrl.replace(/^https?:\/\//, "") : "Unknown Server";
    mf.name += ` (${serverHostname})`;
  }
  mf.behaviorHints.configurationRequired = false;

  res.json(mf);
});

// ──────────────────────────────────────────────────────────────────────────
// STREAM route  →  /<cfg>/stream/<type>/<id>.json
// ──────────────────────────────────────────────────────────────────────────
app.get("/:cfg/stream/:type/:id.json", async (req, res) => {
  let cfg;
  try {
    cfg = decodeCfg(req.params.cfg);
  } catch (err) {
    console.error("⚠️ Failed to decode config in stream route:", err?.message || String(err));
    return res.json({ streams: [] });
  }

  const { id } = req.params;
  if (!cfg.serverUrl || !cfg.userId || !cfg.accessToken)
    return res.json({ streams: [] });

  try {
    // JELLYFIN: Always use Emby client - Jellyfin support commented out for future
    // Select the appropriate client based on serverType (defaults to 'emby' for backward compatibility)
    // const client = cfg.serverType === 'jellyfin' ? jellyfinClient : embyClient;
    const client = embyClient;
    const raw = await client.getStream(id, cfg);
    
    // Get custom stream name from config (defaults based on server type)
    const streamName = cfg.streamName || (cfg.serverType === 'jellyfin' ? 'Jellyfin' : 'Emby');
    
    // Get hideStreamTypes from config (defaults to empty array for backward compatibility)
    const hideStreamTypes = cfg.hideStreamTypes || [];
         
    const streams = (raw || [])
      .filter(s => s.directPlayUrl)
      .filter(s => !shouldFilterStream(s, hideStreamTypes)) // Filter based on user preferences
      .map(s => {
        // Build behaviorHints with enriched data
        const behaviorHints = {
          filename: s.mediaInfo?.filename ?? undefined,
          videoSize: s.mediaInfo?.size ?? undefined,
          notWebReady: true, // Default to true for safety
          bingeGroup: `${streamName}-${(s.qualityTitle || "Direct Play").trim()}` // Same stream name+quality = consistent auto-play across episodes
        };

        // videoHash: consistent per-media-source hash for OpenSubtitles cross-device subtitle sync.
        // Not a real OSDB file hash (we can't read file bytes via Emby API), but provides a
        // stable identifier so the same media source gets the same subtitles across devices.
        if (s.itemId && s.mediaSourceId) {
          behaviorHints.videoHash = crypto
            .createHash("sha256")
            .update(`${s.itemId}:${s.mediaSourceId}`)
            .digest("hex")
            .slice(0, 16);
        }

        // proxyHeaders: pass auth token via header for Stremio's streaming server proxy.
        // Works on Desktop and Android (non-HLS). Stremio Web ignores proxyHeaders,
        // so api_key is kept in the URL as the primary auth mechanism for compatibility.
        behaviorHints.proxyHeaders = {
          request: { "X-Emby-Token": cfg.accessToken }
        };

        return {
          name: streamName, // Use custom stream name from config
          description: s.streamDescription || s.qualityTitle || "Direct Play", // Full detailed technical information
          url: s.directPlayUrl,
          behaviorHints: behaviorHints,
          subtitles: (cfg.includeSubtitles === false) ? [] : (s.subtitles || []) // Include subtitles unless user opted out
        };
      });
    // Set cache based on whether streams were found
    if (streams.length > 0) {
      res.set('Cache-Control', 'public, max-age=120');  // Cache for 2 minutes when streams exist
    } else {
      res.set('Cache-Control', 'no-cache');  // Don't cache empty results
    }

    res.json({ streams });
  } catch (e) {
    // SECURITY: Only log error message and stack, not the full error object which might contain config
    console.error("Stream handler error:", e?.message || String(e));
    if (e?.stack && process.env.NODE_ENV === 'development') {
      console.error("Stack trace:", e.stack);
    }
    res.json({ streams: [] });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// CATALOG route  →  /<cfg>/catalog/<type>/<id>.json
//     Returns "Continue Watching" items from Emby's Resume endpoint
// ──────────────────────────────────────────────────────────────────────────
app.get("/:cfg/catalog/:type/:id.json", async (req, res) => {
  let cfg;
  try {
    cfg = decodeCfg(req.params.cfg);
  } catch (err) {
    console.error("⚠️ Failed to decode config in catalog route:", err?.message || String(err));
    return res.json({ metas: [] });
  }

  const { type, id } = req.params;
  if (!cfg.serverUrl || !cfg.userId || !cfg.accessToken)
    return res.json({ metas: [] });

  const validCatalogs = ["continue-watching-movies", "continue-watching-series"];
  if (!validCatalogs.includes(id)) return res.json({ metas: [] });

  try {
    const client = embyClient;
    const metas = await client.getResumeItems(cfg, type);

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json({ metas: metas || [] });
  } catch (e) {
    console.error("Catalog handler error:", e?.message || String(e));
    if (e?.stack && process.env.NODE_ENV === "development") {
      console.error("Stack trace:", e.stack);
    }
    res.json({ metas: [] });
  }
});

app.get("/:cfg/catalog/:type/:id/:extra.json", async (req, res) => {
  let cfg;
  try {
    cfg = decodeCfg(req.params.cfg);
  } catch (err) {
    console.error("⚠️ Failed to decode config in catalog route:", err?.message || String(err));
    return res.json({ metas: [] });
  }

  const { type, id, extra } = req.params;
  if (!cfg.serverUrl || !cfg.userId || !cfg.accessToken)
    return res.json({ metas: [] });

  const validCatalogs = ["continue-watching-movies", "continue-watching-series"];
  if (!validCatalogs.includes(id)) return res.json({ metas: [] });

  let skip = 0;
  const skipMatch = extra.match(/skip=(\d+)/);
  if (skipMatch) skip = parseInt(skipMatch[1], 10);

  try {
    const client = embyClient;
    const metas = await client.getResumeItems(cfg, type, skip);

    res.set("Cache-Control", "no-cache, no-store, must-revalidate");
    res.json({ metas: metas || [] });
  } catch (e) {
    console.error("Catalog handler error:", e?.message || String(e));
    if (e?.stack && process.env.NODE_ENV === "development") {
      console.error("Stack trace:", e.stack);
    }
    res.json({ metas: [] });
  }
});

// ──────────────────────────────────────────────────────────────────────────
// FALLBACK manifest for users who hit /manifest.json with no cfg
//     (Stremio will show its built-in config form)
// ──────────────────────────────────────────────────────────────────────────
app.get("/manifest.json", (_req, res) => {
  const mf = baseManifest();
  if (!mf) {
    console.error("[FATAL] baseManifest() returned undefined for fallback route.");
    return res.status(500).json({ err: "Server error: Failed to generate base manifest object." });
  }
  res.json(mf);
});

// ──────────────────────────────────────────────────────────────────────────
// CONFIGURE route  →  /configure
// ──────────────────────────────────────────────────────────────────────────
app.get("/configure", (_req, res) =>
  res.sendFile(path.join(__dirname, "public", "configure.html")));

app.get("/:cfg/configure", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "configure.html"));
});
// ──────────────────────────────────────────────────────────────────────────
// Start the server
// ──────────────────────────────────────────────────────────────────────────
app.listen(PORT, () =>
  console.log(`🚀  StreamBridge up at http://localhost:${PORT}/<cfg>/manifest.json`)
);
