const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const sync = require("./sync-engine.js");
const sb = require("./supabase.js");

// 1. Profanity filter: blocks real profanity + obfuscations without false positives
assert.equal(sb.containsBadWord("anjir keren banget filmnya").clean, true);
assert.equal(sb.containsBadWord("Anjayyyyy mantap bro").clean, true);
assert.equal(sb.containsBadWord("cewek di sebelah panjang rambutnya").clean, true);
assert.equal(sb.containsBadWord("telepon nokia baru kotor nih").clean, true);
assert.equal(sb.containsBadWord("lanjut nonton yuk").clean, true);
assert.equal(sb.containsBadWord("dasar anjing lo").clean, false);
assert.equal(sb.containsBadWord("dasar anj lu").clean, false);
assert.equal(sb.containsBadWord("anjjjj parah").clean, false);
assert.equal(sb.containsBadWord("babi lu").clean, false);
assert.equal(sb.containsBadWord("babiii!").clean, false);
assert.equal(sb.containsBadWord("k.o.n.t.o.l").clean, false);

// censorBadWords preserves casing and safe words
assert.equal(sb.censorBadWords("Anjir bro, panjang banget"), "Anjir bro, panjang banget");
assert.equal(sb.censorBadWords("dasar Anjing dan babi!"), "dasar *** dan ***!");

// 2. Short room ID generation
const id1 = sb.generateShortId(6);
assert.match(id1, /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

// 3. URL & local video parsing
assert.equal(sync.isYouTubeUrl("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), true);
assert.equal(sync.getYouTubeVideoId("https://youtu.be/dQw4w9WgXcQ?t=42"), "dQw4w9WgXcQ");
assert.equal(sync.getYouTubeVideoId("https://youtube.com/shorts/abcDEF12345"), "abcDEF12345");
assert.equal(sync.isGoogleDriveUrl("https://drive.google.com/file/d/1AbCdEfG99/view"), true);
assert.equal(sync.getGoogleDriveFileId("https://drive.google.com/file/d/1AbCdEfG99/view"), "1AbCdEfG99");
const localUri = sync.makeLocalVideoUrl("Film Bagus (1080p).mp4");
assert.equal(sync.isLocalVideoUrl(localUri), true);
assert.equal(sync.getLocalVideoName(localUri), "Film Bagus (1080p).mp4");

// 4. HTML escaping against XSS
assert.equal(
  sync.escapeHtml('<img src=x onerror="alert(1)">'),
  "&lt;img src=x onerror=&quot;alert(1)&quot;&gt;",
);

// 5. NTP-style clock calibration & minimum-RTT filtering
// Host clock is +2000ms ahead of guest clock; packet takes 100ms each way (RTT = 200ms).
// clientSent=1000, hostTime=3100 (at arrival), clientRecv=1200 -> offset = 3100 + 100 - 1200 = +2000ms
const s1 = sync.estimateClockSample(1000, 3100, 1200);
assert.deepEqual(s1, { rttMs: 200, offsetMs: 2000 });
// Queued slow sample: RTT = 800ms
const s2 = sync.estimateClockSample(2000, 4400, 2800);
assert.equal(sync.pickBestClockSample([s2, s1]).rttMs, 200);
assert.equal(sync.pickBestClockSample([s2, s1]).offsetMs, 2000);
assert.equal(sync.estimateClockSample(2000, 4000, 1900), null); // negative RTT rejected

// 6. Projected target time compensates clock skew & transit time
const projected = sync.computeTargetPlaybackTime({
  status: "play",
  currentTime: 100.0,
  sentAt: 50000, // host timestamp
  nowMs: 48450, // guest local time when applying (450ms real elapsed under +2000ms host offset)
  clockOffsetMs: 2000,
});
assert.equal(Number(projected.toFixed(2)), 100.45);

// When paused, no forward projection
const pausedProjected = sync.computeTargetPlaybackTime({
  status: "pause",
  currentTime: 52.5,
  sentAt: 50000,
  nowMs: 55000,
  clockOffsetMs: 0,
});
assert.equal(pausedProjected, 52.5);

// 7. Adaptive sync decision (no micro-seek stutter for small drift)
assert.equal(
  sync.decideSyncAction({ status: "play", targetTime: 100.04, localTime: 100.0, playerType: "html5" }).action,
  "aligned",
);
assert.equal(sync.SEEK_THRESHOLD_SEC, 0.45);
const nudge = sync.decideSyncAction({ status: "play", targetTime: 100.35, localTime: 100.0, playerType: "html5" });
assert.equal(nudge.action, "rate_adjust");
assert.ok(nudge.rate > 1.0 && nudge.rate <= 1.08);
const bigJump = sync.decideSyncAction({ status: "play", targetTime: 101.2, localTime: 100.0, playerType: "youtube" });
assert.equal(bigJump.action, "seek_play");
assert.equal(
  sync.decideSyncAction({ status: "pause", targetTime: 50.5, localTime: 50.0, playerType: "html5" }).action,
  "seek_pause",
);
// iOS thresholds avoid micro-seek/rate churn under normal jitter unless forceSeek
assert.equal(
  sync.decideSyncAction({
    status: "play",
    targetTime: 100.85,
    localTime: 100.0,
    playerType: "youtube",
    youtubeSeekThresholdSec: 1.1,
  }).action,
  "aligned",
);
assert.equal(
  sync.decideSyncAction({
    status: "play",
    targetTime: 100.15,
    localTime: 100.0,
    playerType: "html5",
    html5RateDeadbandSec: 0.22,
  }).action,
  "aligned",
);
assert.equal(
  sync.decideSyncAction({
    status: "play",
    targetTime: 100.85,
    localTime: 100.0,
    playerType: "youtube",
    forceSeek: true,
    youtubeSeekThresholdSec: 1.1,
  }).action,
  "seek_play",
);
// YouTube gentle rate_adjust avoids seek-buffer loops inside wide tick seek band
assert.equal(
  sync.decideSyncAction({
    status: "play",
    targetTime: 100.25,
    localTime: 100.0,
    playerType: "youtube",
    youtubeSeekThresholdSec: 1.85,
    youtubeRateDeadbandSec: 0.35,
  }).action,
  "aligned",
);
const ytCatchUp = sync.decideSyncAction({
  status: "play",
  targetTime: 100.90,
  localTime: 100.0,
  playerType: "youtube",
  youtubeSeekThresholdSec: 1.85,
  youtubeRateDeadbandSec: 0.35,
});
assert.equal(ytCatchUp.action, "rate_adjust");
assert.ok(ytCatchUp.rate > 1.0 && ytCatchUp.rate <= 1.08);
const ytSlowDown = sync.decideSyncAction({
  status: "play",
  targetTime: 99.10,
  localTime: 100.0,
  playerType: "youtube",
  youtubeSeekThresholdSec: 1.85,
  youtubeRateDeadbandSec: 0.35,
});
assert.equal(ytSlowDown.action, "rate_adjust");
assert.ok(ytSlowDown.rate < 1.0 && ytSlowDown.rate >= 0.92);
assert.equal(
  sync.decideSyncAction({
    status: "play",
    targetTime: 102.20,
    localTime: 100.0,
    playerType: "youtube",
    youtubeSeekThresholdSec: 1.85,
    youtubeRateDeadbandSec: 0.35,
  }).action,
  "seek_play",
);

// 8. Host election determinism & online host detection
assert.equal(sync.hasOnlineHost({}), false);
assert.equal(
  sync.hasOnlineHost({ u1: [{ user_id: "u1", is_host: false }], u2: [{ user_id: "u2", is_host: true }] }),
  true,
);
const tieStateA = {
  host1: [{ user_id: "host1", user_name: "Host", is_host: true, joined_at: "2026-01-01T10:00:00.000Z" }],
  guest_b: [{ user_id: "guest_b", user_name: "Budi", is_host: false, joined_at: "2026-01-01T10:05:00.000Z" }],
  guest_a: [{ user_id: "guest_a", user_name: "Ani", is_host: false, joined_at: "2026-01-01T10:05:00.000Z" }],
};
const tieStateB = {
  guest_a: tieStateA.guest_a,
  host1: tieStateA.host1,
  guest_b: tieStateA.guest_b,
};
assert.equal(sync.selectNextHostCandidate(tieStateA).id, "guest_a");
assert.equal(sync.selectNextHostCandidate(tieStateB).id, "guest_a");
assert.equal(sync.selectNextHostCandidate(tieStateA, ["guest_a"]).id, "guest_b");
assert.equal(sync.selectNextHostCandidate(tieStateA, ["guest_a", "guest_b"]), null);
assert.equal(sync.truncateChatSnippet("   Halo    dunia   watch   party   ", 20), "Halo dunia watch...");

// 9. Static anti-slop guard: zero em dashes across deliverables
for (const file of ["index.html", "room.html", "style.css", "supabase.js", "sync-engine.js", "voice.js"]) {
  const txt = fs.readFileSync(path.join(__dirname, file), "utf8");
  assert.equal(txt.includes("\u2014"), false, `${file} contains forbidden em dash`);
}

console.log("All sync-engine, profanity, security, and anti-slop checks passed.");
