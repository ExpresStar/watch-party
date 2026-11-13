/**
 * Shared URL helpers & latency-compensated playback sync engine.
 * Works in browser (window.watchPartySync) and Node (module.exports).
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.watchPartySync = api;
  }
})(typeof window !== "undefined" ? window : globalThis, function () {
  const LOCAL_PREFIX = "local://";

  function escapeHtml(text) {
    if (text == null) return "";
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  function isYouTubeUrl(url) {
    if (!url || typeof url !== "string") return false;
    return /(?:youtube\.com|youtu\.be)/i.test(url);
  }

  function getYouTubeVideoId(url) {
    if (!url || typeof url !== "string") return null;
    const patterns = [
      /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/,
      /youtube\.com\/watch\?.*v=([^&\n?#]+)/,
      /youtube\.com\/shorts\/([^&\n?#]+)/,
      /youtube\.com\/live\/([^&\n?#]+)/,
    ];
    for (const pattern of patterns) {
      const match = url.match(pattern);
      if (match && match[1]) return match[1];
    }
    return null;
  }

  function isGoogleDriveUrl(url) {
    if (!url || typeof url !== "string") return false;
    return /(?:drive\.google\.com|docs\.google\.com)/i.test(url);
  }

  function getGoogleDriveFileId(url) {
    if (!url || typeof url !== "string") return null;
    let match = url.match(/\/file\/d\/([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    match = url.match(/[?&]id=([a-zA-Z0-9_-]+)/);
    if (match) return match[1];
    return null;
  }

  function isLocalVideoUrl(url) {
    return typeof url === "string" && url.startsWith(LOCAL_PREFIX);
  }

  function makeLocalVideoUrl(fileName) {
    const clean = (fileName || "video.mp4").trim();
    return LOCAL_PREFIX + encodeURIComponent(clean);
  }

  function getLocalVideoName(url) {
    if (!isLocalVideoUrl(url)) return "";
    try {
      return decodeURIComponent(url.slice(LOCAL_PREFIX.length));
    } catch {
      return url.slice(LOCAL_PREFIX.length);
    }
  }

  /**
   * Estimate one NTP-style clock offset sample: hostNow approx = localNow + offsetMs.
   */
  function estimateClockSample(clientSentMs, hostTimeMs, clientRecvMs) {
    if (
      !Number.isFinite(clientSentMs) ||
      !Number.isFinite(hostTimeMs) ||
      !Number.isFinite(clientRecvMs)
    ) {
      return null;
    }
    const rttMs = clientRecvMs - clientSentMs;
    if (rttMs < 0 || rttMs > 15000) return null;
    const offsetMs = hostTimeMs + rttMs / 2 - clientRecvMs;
    return { rttMs, offsetMs };
  }

  /**
   * Pick the lowest-RTT sample (minimizes queuing noise across multiple pings).
   */
  function pickBestClockSample(samples) {
    if (!Array.isArray(samples) || samples.length === 0) {
      return { rttMs: null, offsetMs: 0 };
    }
    let best = null;
    for (const s of samples) {
      if (!s || !Number.isFinite(s.rttMs) || !Number.isFinite(s.offsetMs)) continue;
      if (!best || s.rttMs < best.rttMs) {
        best = s;
      }
    }
    return best || { rttMs: null, offsetMs: 0 };
  }

  /**
   * Project the host's true playback position at nowMs using clock offset & elapsed time.
   */
  function computeTargetPlaybackTime({
    status,
    currentTime,
    sentAt,
    nowMs,
    clockOffsetMs = 0,
    maxCompensationSec = 15,
  }) {
    const baseTime = Number.isFinite(currentTime) && currentTime > 0 ? currentTime : 0;
    if (status !== "play" || !Number.isFinite(sentAt) || !Number.isFinite(nowMs)) {
      return baseTime;
    }
    const estimatedHostNow = nowMs + (Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0);
    const rawElapsedSec = (estimatedHostNow - sentAt) / 1000;
    // Clamp slightly negative jitter to 0 and cap runaway stale packets.
    const elapsedSec = Math.max(0, Math.min(rawElapsedSec, maxCompensationSec));
    return baseTime + elapsedSec;
  }

  const SEEK_THRESHOLD_SEC = 0.45;

  /**
   * Decide exact action for guest player to stay synchronized without unnecessary seeks.
   */
  function decideSyncAction({
    status,
    targetTime,
    localTime,
    playerType = "html5",
    forceSeek = false,
    youtubeSeekThresholdSec = SEEK_THRESHOLD_SEC,
    html5SeekThresholdSec = 0.70,
    html5RateDeadbandSec = 0.08,
  }) {
    const safeTarget = Number.isFinite(targetTime) && targetTime > 0 ? targetTime : 0;
    const safeLocal = Number.isFinite(localTime) && localTime > 0 ? localTime : 0;
    const drift = safeTarget - safeLocal;

    if (status === "pause") {
      if (forceSeek || Math.abs(drift) > 0.12) {
        return { action: "seek_pause", targetTime: safeTarget, drift, rate: 1.0 };
      }
      return { action: "pause", targetTime: safeTarget, drift, rate: 1.0 };
    }

    const seekThreshold = playerType === "youtube" ? youtubeSeekThresholdSec : html5SeekThresholdSec;
    if (forceSeek || Math.abs(drift) > seekThreshold) {
      return { action: "seek_play", targetTime: safeTarget, drift, rate: 1.0 };
    }

    if (playerType === "html5" && Math.abs(drift) > html5RateDeadbandSec) {
      // Gently speed up or slow down playbackRate instead of stutter-seeking.
      const nudge = 1 + drift * 0.14;
      const clamped = Math.max(0.92, Math.min(1.08, nudge));
      const rate = Math.round(clamped * 100) / 100;
      return { action: "rate_adjust", targetTime: safeTarget, drift, rate };
    }

    return { action: "aligned", targetTime: safeTarget, drift, rate: 1.0 };
  }

  return {
    SEEK_THRESHOLD_SEC,
    escapeHtml,
    isYouTubeUrl,
    getYouTubeVideoId,
    isGoogleDriveUrl,
    getGoogleDriveFileId,
    isLocalVideoUrl,
    makeLocalVideoUrl,
    getLocalVideoName,
    estimateClockSample,
    pickBestClockSample,
    computeTargetPlaybackTime,
    decideSyncAction,
  };
});
