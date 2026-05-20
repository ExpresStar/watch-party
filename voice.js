/**
 * voice.js — Voice Chat Module menggunakan PeerJS (WebRTC P2P)
 *
 * Arsitektur: Full Mesh P2P
 * - Setiap user koneksi langsung ke setiap user lain
 * - Cocok untuk 2-8 orang
 * - Tidak butuh media server (gratis!)
 *
 * Signaling: PeerJS cloud server (gratis)
 * NAT Traversal: STUN server Google (gratis)
 * Audio Codec: Opus (browser default, efisien ~6-40KB/s per user)
 *
 * Usage:
 *   VoiceChat.init({ roomId, userId, userName, callbacks })
 *   await VoiceChat.joinVoice()       // Join voice (butuh user gesture!)
 *   VoiceChat.toggleMute()            // Mute/unmute
 *   VoiceChat.connectToPeer(uid, pid) // Connect ke peer lain
 *   VoiceChat.removePeer(uid)         // Disconnect
 *   VoiceChat.destroy()               // Cleanup
 */

const VoiceChat = (() => {
  // ===== STATE =====
  let peer = null;
  let localStream = null;
  let isJoined = false;
  let isMuted = false;
  let myPeerId = null;
  let userId = null;
  let userName = null;

  // P2P connections
  let calls = {}; // { userId: MediaConnection }
  let dataConns = {}; // { userId: DataConnection }
  let remoteAudios = {}; // { userId: HTMLAudioElement }
  let peerToUser = {}; // { peerId: userId }
  let userToPeer = {}; // { userId: peerId }

  // Speaking detection (Web Audio API AnalyserNode)
  let speakingState = {}; // { userId: boolean }
  let speakIntervals = {}; // { userId: intervalId }
  const VOLUME_THRESHOLD = 0.015;

  // Callbacks
  let cb = {
    onStateChange: () => {},
    onPeerJoined: () => {},
    onPeerLeft: () => {},
    onSpeakingChange: () => {},
    onError: () => {},
  };

  // ===== INIT =====

  function init(config) {
    userId = config.userId;
    userName = config.userName || "Guest";
    if (config.callbacks) Object.assign(cb, config.callbacks);

    return new Promise((resolve, reject) => {
      peer = new Peer(undefined, {
        config: {
          iceServers: [
            { urls: "stun:stun.l.google.com:19302" },
            { urls: "stun:stun1.l.google.com:19302" },
          ],
        },
      });

      const timeout = setTimeout(() => {
        reject(new Error("Voice init timeout"));
      }, 15000);

      peer.on("open", (id) => {
        clearTimeout(timeout);
        myPeerId = id;
        console.log("[Voice] Peer ready:", id);
        resolve(id);
      });

      peer.on("call", handleIncomingCall);
      peer.on("connection", handleIncomingDataConn);

      peer.on("error", (err) => {
        console.warn("[Voice] Peer error:", err.type);
        if (err.type === "peer-unavailable") {
          const uid = peerToUser[err.message];
          if (uid) removePeer(uid);
        }
      });

      peer.on("disconnected", () => {
        setTimeout(() => {
          if (peer && !peer.destroyed) peer.reconnect();
        }, 3000);
      });
    });
  }

  // ===== JOIN / LEAVE =====

  async function joinVoice() {
    if (isJoined) return true;

    try {
      localStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });

      isJoined = true;
      isMuted = false;
      cb.onStateChange({ isJoined: true, isMuted: false });

      console.log("[Voice] Joined voice chat");
      return true;
    } catch (err) {
      console.error("[Voice] Mic error:", err);
      cb.onError({ message: "Gagal mengakses mikrofon" });
      return false;
    }
  }

  function leaveVoice() {
    if (!isJoined) return;

    isJoined = false;
    isMuted = false;

    // Stop mic
    if (localStream) {
      localStream.getTracks().forEach((t) => t.stop());
      localStream = null;
    }

    // Close all connections
    Object.keys(calls).forEach((uid) => removePeer(uid));

    cb.onStateChange({ isJoined: false, isMuted: false });
    console.log("[Voice] Left voice chat");
  }

  function toggleMute() {
    if (!isJoined || !localStream) return isMuted;
    isMuted = !isMuted;
    localStream.getAudioTracks().forEach((t) => {
      t.enabled = !isMuted;
    });
    cb.onStateChange({ isJoined: true, isMuted: isMuted });
    return isMuted;
  }

  // ===== P2P CONNECTIONS =====

  function connectToPeer(targetUserId, targetPeerId) {
    if (targetUserId === userId) return;
    if (calls[targetUserId]) return; // Already connected
    if (!myPeerId) return; // Not ready yet

    console.log("[Voice] Connecting to", targetUserId);
    peerToUser[targetPeerId] = targetUserId;
    userToPeer[targetUserId] = targetPeerId;

    // Data connection (untuk kirim status mute)
    try {
      const dc = peer.connect(targetPeerId, {
        reliable: true,
        metadata: { userId: userId, userName: userName },
      });
      dc.on("open", () => {
        dataConns[targetUserId] = dc;
        // Kirim status mute kita ke peer baru
        dc.send(
          JSON.stringify({
            type: "voice_state",
            userId: userId,
            isMuted: isMuted,
          }),
        );
      });
      dc.on("data", (data) => handleDataMsg(targetUserId, data));
      dc.on("close", () => delete dataConns[targetUserId]);
    } catch (e) {
      console.warn("[Voice] DC error:", e);
    }

    // Media call (audio stream)
    if (localStream) {
      try {
        const call = peer.call(targetPeerId, localStream, {
          metadata: { userId: userId, userName: userName },
        });
        if (call) {
          calls[targetUserId] = call;
          call.on("stream", (stream) => {
            if (stream.getAudioTracks().length > 0) {
              playRemoteAudio(targetUserId, stream);
              cb.onPeerJoined(targetUserId);
            }
          });
          call.on("close", () => removePeer(targetUserId));
          call.on("error", () => removePeer(targetUserId));
        }
      } catch (e) {
        console.warn("[Voice] Call error:", e);
      }
    }
  }

  function handleIncomingCall(call) {
    const meta = call.metadata || {};
    const callerId = meta.userId;
    if (!callerId || callerId === userId) return;

    peerToUser[call.peer] = callerId;
    userToPeer[callerId] = call.peer;

    // Answer dengan stream kita (atau muted answer kalau belum join voice)
    if (localStream) {
      call.answer(localStream);
    } else {
      call.answer();
    }

    calls[callerId] = call;

    call.on("stream", (stream) => {
      if (stream.getAudioTracks().length > 0) {
        playRemoteAudio(callerId, stream);
        cb.onPeerJoined(callerId);
      }
    });
    call.on("close", () => removePeer(callerId));
  }

  function handleIncomingDataConn(conn) {
    const meta = conn.metadata || {};
    const senderId = meta.userId;
    if (!senderId) return;

    peerToUser[conn.peer] = senderId;
    userToPeer[senderId] = conn.peer;

    conn.on("open", () => {
      dataConns[senderId] = conn;
      conn.send(
        JSON.stringify({
          type: "voice_state",
          userId: userId,
          isMuted: isMuted,
        }),
      );
    });
    conn.on("data", (data) => handleDataMsg(senderId, data));
    conn.on("close", () => delete dataConns[senderId]);
  }

  function handleDataMsg(fromId, rawData) {
    try {
      const msg = typeof rawData === "string" ? JSON.parse(rawData) : rawData;
      if (msg.type === "voice_state" && msg.userId !== userId) {
        cb.onStateChange({ userId: msg.userId, isMuted: msg.isMuted });
      }
    } catch (e) {}
  }

  function removePeer(targetUserId) {
    // Close call
    if (calls[targetUserId]) {
      try {
        calls[targetUserId].close();
      } catch (e) {}
      delete calls[targetUserId];
    }
    // Close data conn
    if (dataConns[targetUserId]) {
      try {
        dataConns[targetUserId].close();
      } catch (e) {}
      delete dataConns[targetUserId];
    }
    // Remove audio element
    if (remoteAudios[targetUserId]) {
      remoteAudios[targetUserId].pause();
      remoteAudios[targetUserId].srcObject = null;
      remoteAudios[targetUserId].remove();
      delete remoteAudios[targetUserId];
    }
    // Clear speaking detection
    if (speakIntervals[targetUserId]) {
      clearInterval(speakIntervals[targetUserId]);
      delete speakIntervals[targetUserId];
    }
    if (speakingState[targetUserId]) {
      delete speakingState[targetUserId];
      cb.onSpeakingChange(targetUserId, false);
    }
    // Clean maps
    const pid = userToPeer[targetUserId];
    if (pid) {
      delete peerToUser[pid];
      delete userToPeer[targetUserId];
    }

    cb.onPeerLeft(targetUserId);
  }

  // ===== REMOTE AUDIO =====

  function playRemoteAudio(uid, stream) {
    // Remove existing kalau ada
    if (remoteAudios[uid]) {
      remoteAudios[uid].pause();
      remoteAudios[uid].srcObject = null;
      remoteAudios[uid].remove();
    }

    const audio = new Audio();
    audio.srcObject = stream;
    audio.autoplay = true;
    audio.playsInline = true;
    document.body.appendChild(audio);
    remoteAudios[uid] = audio;

    audio.play().catch(() => {});

    // Speaking detection
    startSpeakingDetection(uid, stream);
  }

  function startSpeakingDetection(uid, stream) {
    if (speakIntervals[uid]) clearInterval(speakIntervals[uid]);

    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.8;
      src.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);

      speakIntervals[uid] = setInterval(() => {
        if (!remoteAudios[uid]) {
          clearInterval(speakIntervals[uid]);
          delete speakIntervals[uid];
          return;
        }
        analyser.getByteFrequencyData(data);
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        const vol = sum / data.length / 255;

        const isSpeaking = vol > VOLUME_THRESHOLD;
        if (isSpeaking !== !!speakingState[uid]) {
          speakingState[uid] = isSpeaking;
          cb.onSpeakingChange(uid, isSpeaking);
        }
      }, 200);
    } catch (e) {
      console.warn("[Voice] Speaking detection failed for", uid);
    }
  }

  // ===== GETTERS =====

  function getPeerId() {
    return myPeerId;
  }
  function getIsJoined() {
    return isJoined;
  }
  function getIsMuted() {
    return isMuted;
  }
  function getPeers() {
    return Object.keys(calls);
  }
  function isSpeaking(uid) {
    return !!speakingState[uid];
  }

  function destroy() {
    leaveVoice();
    if (peer) {
      peer.destroy();
      peer = null;
    }
    myPeerId = null;
  }

  // ===== PUBLIC API =====
  return {
    init,
    joinVoice,
    leaveVoice,
    toggleMute,
    connectToPeer,
    removePeer,
    getPeerId,
    getIsJoined,
    getIsMuted,
    getPeers,
    isSpeaking,
    destroy,
  };
})();
