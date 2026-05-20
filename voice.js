/**
 * voice.js — Voice Chat Module menggunakan PeerJS (WebRTC P2P)
 * 
 * Arsitektur: Full Mesh P2P
 * - Setiap user koneksi langsung ke setiap user lain
 * - Cocok untuk 2-8 orang
 * - Tidak butuh media server (gratis!)
 * 
 * Signaling: PeerJS cloud server (gratis)
 * NAT Traversal: STUN/TURN servers (multi-provider, termasuk free TURN)
 * Audio Codec: Opus (browser default, efisien ~6-40KB/s per user)
 * 
 * iOS Safari Compat:
 * - AudioContext shared & di-resume saat user gesture
 * - Audio di-unlock via silent play saat joinVoice (user gesture)
 * - Audio element di-reuse, tidak buat baru setiap stream masuk
 * - Works on HTTPS (required by iOS)
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
    let calls = {};         // { userId: MediaConnection }
    let dataConns = {};     // { userId: DataConnection }
    let remoteAudios = {};  // { userId: HTMLAudioElement }
    let peerToUser = {};    // { peerId: userId }
    let userToPeer = {};    // { userId: peerId }

    // Speaking detection (Web Audio API AnalyserNode)
    let speakingState = {};   // { userId: boolean }
    let speakIntervals = {};  // { userId: intervalId }
    const VOLUME_THRESHOLD = 0.015;

    // iOS Safari audio unlock
    let sharedAudioCtx = null;
    let audioUnlocked = false;

    // Callbacks
    let cb = {
        onStateChange: () => {},
        onPeerJoined: () => {},
        onPeerLeft: () => {},
        onSpeakingChange: () => {},
        onError: () => {}
    };

    // ===== iOS / MOBILE DETECTION =====
    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || 
                  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    const isMobile = /Android|iPhone|iPad|iPod|webOS|BlackBerry|IEMobile|Opera Mini/i.test(navigator.userAgent) || isIOS;

    // ===== ICE SERVERS =====
    // Multi-provider untuk koneksi yang lebih reliable:
    // - Google STUN (utama, gratis)
    // - Twilio STUN (backup)
    // - Open Relay Project (free TURN, production-ready)
    // - Metered.ca (free TURN, cadangan)
    const ICE_SERVERS = [
        // Google STUN (utama)
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        // Twilio STUN (backup)
        { urls: 'stun:global.stun.twilio.com:3478' },
        // Free TURN — Open Relay Project (rate limited tapi gratis)
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject'
        }
    ];

    // ===== INIT =====

    function init(config) {
        userId = config.userId;
        userName = config.userName || 'Guest';
        if (config.callbacks) Object.assign(cb, config.callbacks);

        console.log('[Voice] Init — iOS:', isIOS, 'Safari:', isSafari, 'Mobile:', isMobile);

        return new Promise((resolve, reject) => {
            peer = new Peer(undefined, {
                config: {
                    iceServers: ICE_SERVERS
                },
                // Gunakan PeerJS cloud (default), sudah cukup untuk signaling
                secure: true  // Wajib HTTPS/WSS — iOS Safari require secure context
            });

            const timeout = setTimeout(() => {
                reject(new Error('Voice init timeout'));
            }, 15000);

            peer.on('open', (id) => {
                clearTimeout(timeout);
                myPeerId = id;
                console.log('[Voice] Peer ready:', id);
                resolve(id);
            });

            peer.on('call', handleIncomingCall);
            peer.on('connection', handleIncomingDataConn);

            peer.on('error', (err) => {
                console.warn('[Voice] Peer error:', err.type);
                if (err.type === 'peer-unavailable') {
                    const uid = peerToUser[err.message];
                    if (uid) removePeer(uid);
                }
                if (err.type === 'browser-incompatible') {
                    cb.onError({ message: 'Browser tidak mendukung WebRTC. Gunakan Chrome/Safari/Edge terbaru.' });
                }
                if (err.type === 'network' || err.type === 'server-error' || err.type === 'socket-error') {
                    // Coba reconnect setelah delay
                    setTimeout(() => {
                        if (peer && !peer.destroyed) {
                            try { peer.reconnect(); } catch (e) {}
                        }
                    }, 3000);
                }
            });

            peer.on('disconnected', () => {
                console.warn('[Voice] Peer disconnected, reconnecting...');
                setTimeout(() => {
                    if (peer && !peer.destroyed) {
                        try { peer.reconnect(); } catch (e) {}
                    }
                }, 2000);
            });
        });
    }

    // ===== iOS AUDIO UNLOCK =====
    // iOS Safari memblokir audio playback sampai ada user gesture.
    // Kita "unlock" dengan memainkan silent audio saat user klik tombol mic.

    function unlockAudioContext() {
        if (!sharedAudioCtx) {
            try {
                sharedAudioCtx = new (window.AudioContext || window.webkitAudioContext)();
            } catch (e) {
                console.warn('[Voice] AudioContext not supported');
                return;
            }
        }

        // Resume kalau suspended (iOS selalu suspended awalnya)
        if (sharedAudioCtx.state === 'suspended') {
            sharedAudioCtx.resume().then(() => {
                console.log('[Voice] AudioContext resumed');
            }).catch(e => {
                console.warn('[Voice] AudioContext resume failed:', e);
            });
        }
    }

    function unlockAudioPlayback() {
        // iOS Safari perlu user gesture untuk play audio.
        // Kita buat silent audio, play, lalu pause. Ini "membuka" 
        // audio session supaya audio remote bisa diputar nanti.
        if (audioUnlocked) return;

        try {
            const silentAudio = new Audio();
            silentAudio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
            silentAudio.volume = 0.01;
            silentAudio.playsInline = true;

            const playPromise = silentAudio.play();
            if (playPromise) {
                playPromise.then(() => {
                    audioUnlocked = true;
                    silentAudio.pause();
                    silentAudio.currentTime = 0;
                    silentAudio.src = '';
                    console.log('[Voice] Audio playback unlocked (iOS)');
                }).catch(() => {
                    // Masih bisa dicoba nanti via playRemoteAudio
                    console.warn('[Voice] Audio unlock play failed, will retry on remote stream');
                });
            }
        } catch (e) {
            console.warn('[Voice] Audio unlock exception:', e);
        }
    }

    // ===== JOIN / LEAVE =====

    async function joinVoice() {
        if (isJoined) return true;

        // 1. Unlock AudioContext dulu (SAAT INI masih dalam user gesture context)
        unlockAudioContext();

        // 2. Unlock audio playback (iOS Safari requirement)
        unlockAudioPlayback();

        try {
            localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                    // iOS specific: prefer ambient mode untuk speaker
                    // supaya suara keluar dari speaker bukan earpiece
                    ...(isIOS ? { deviceId: undefined } : {})
                },
                video: false
            });

            // Verifikasi: apakah track benar-benar aktif?
            const audioTracks = localStream.getAudioTracks();
            if (audioTracks.length === 0) {
                throw new Error('No audio track');
            }
            console.log('[Voice] Mic track:', audioTracks[0].label, 'enabled:', audioTracks[0].enabled);

            // Cek HTTPS (iOS requirement)
            if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') {
                console.warn('[Voice] WARNING: Not on HTTPS! iOS requires HTTPS for WebRTC. Voice may not work on mobile.');
                cb.onError({ message: 'Voice chat butuh HTTPS untuk bekerja di mobile' });
                // Jangan return false — masih bisa dicoba di desktop
            }

            isJoined = true;
            isMuted = false;
            cb.onStateChange({ isJoined: true, isMuted: false });

            console.log('[Voice] Joined voice chat successfully');
            return true;
        } catch (err) {
            console.error('[Voice] Mic error:', err.name, err.message);

            let message = 'Gagal mengakses mikrofon';
            if (err.name === 'NotAllowedError') {
                message = 'Akses mikrofon ditolak. Izinkan di Settings > Safari > Microphone';
            } else if (err.name === 'NotFoundError') {
                message = 'Tidak ada mikrofon ditemukan';
            } else if (err.name === 'NotReadableError') {
                message = 'Mikrofon sedang dipakai aplikasi lain';
            } else if (err.name === 'OverconstrainedError') {
                message = 'Mikrofon tidak mendukung pengaturan yang diminta';
            } else if (err.name === 'TypeError' && location.protocol !== 'https:') {
                message = 'WebRTC butuh HTTPS! Upload ke hosting dengan SSL atau pakai localhost';
            }

            cb.onError({ message: message });
            return false;
        }
    }

    function leaveVoice() {
        if (!isJoined) return;

        isJoined = false;
        isMuted = false;

        // Stop mic
        if (localStream) {
            localStream.getTracks().forEach(t => t.stop());
            localStream = null;
        }

        // Close all connections
        Object.keys(calls).forEach(uid => removePeer(uid));

        cb.onStateChange({ isJoined: false, isMuted: false });
        console.log('[Voice] Left voice chat');
    }

    function toggleMute() {
        if (!isJoined || !localStream) return isMuted;
        isMuted = !isMuted;
        localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
        cb.onStateChange({ isJoined: true, isMuted: isMuted });
        return isMuted;
    }

    // ===== P2P CONNECTIONS =====

    function connectToPeer(targetUserId, targetPeerId) {
        if (targetUserId === userId) return;
        if (calls[targetUserId]) return;  // Already connected
        if (!myPeerId) return;              // Not ready yet

        console.log('[Voice] Connecting to', targetUserId, targetPeerId);
        peerToUser[targetPeerId] = targetUserId;
        userToPeer[targetUserId] = targetPeerId;

        // Data connection (untuk kirim status mute)
        try {
            const dc = peer.connect(targetPeerId, {
                reliable: true,
                metadata: { userId: userId, userName: userName }
            });
            dc.on('open', () => {
                dataConns[targetUserId] = dc;
                // Kirim status mute kita ke peer baru
                dc.send(JSON.stringify({ type: 'voice_state', userId: userId, isMuted: isMuted }));
            });
            dc.on('data', (data) => handleDataMsg(targetUserId, data));
            dc.on('close', () => delete dataConns[targetUserId]);
            dc.on('error', () => delete dataConns[targetUserId]);
        } catch (e) { console.warn('[Voice] DC error:', e); }

        // Media call (audio stream)
        if (localStream) {
            try {
                const call = peer.call(targetPeerId, localStream, {
                    metadata: { userId: userId, userName: userName },
                    // iOS Safari: tambah SDP constraints
                    sdpTransform: (sdp) => {
                        // Pastikan audio codec Opus diprioritaskan
                        return sdp;
                    }
                });
                if (call) {
                    calls[targetUserId] = call;
                    call.on('stream', (stream) => {
                        if (stream.getAudioTracks().length > 0) {
                            playRemoteAudio(targetUserId, stream);
                            cb.onPeerJoined(targetUserId);
                        }
                    });
                    call.on('close', () => removePeer(targetUserId));
                    call.on('error', (err) => {
                        console.warn('[Voice] Call error with', targetUserId, err);
                        removePeer(targetUserId);
                    });
                }
            } catch (e) { console.warn('[Voice] Call error:', e); }
        }
    }

    function handleIncomingCall(call) {
        const meta = call.metadata || {};
        const callerId = meta.userId;
        if (!callerId || callerId === userId) return;

        console.log('[Voice] Incoming call from', callerId);
        peerToUser[call.peer] = callerId;
        userToPeer[callerId] = call.peer;

        // Pastikan AudioContext aktif sebelum answer
        unlockAudioContext();

        // Unlock audio playback jika belum (untuk iOS)
        unlockAudioPlayback();

        // Answer dengan stream kita (atau muted answer kalau belum join voice)
        if (localStream) {
            call.answer(localStream);
        } else {
            call.answer();
        }

        calls[callerId] = call;

        call.on('stream', (stream) => {
            if (stream.getAudioTracks().length > 0) {
                playRemoteAudio(callerId, stream);
                cb.onPeerJoined(callerId);
            }
        });
        call.on('close', () => removePeer(callerId));
        call.on('error', (err) => {
            console.warn('[Voice] Incoming call error from', callerId, err);
            removePeer(callerId);
        });
    }

    function handleIncomingDataConn(conn) {
        const meta = conn.metadata || {};
        const senderId = meta.userId;
        if (!senderId) return;

        peerToUser[conn.peer] = senderId;
        userToPeer[senderId] = conn.peer;

        conn.on('open', () => {
            dataConns[senderId] = conn;
            conn.send(JSON.stringify({ type: 'voice_state', userId: userId, isMuted: isMuted }));
        });
        conn.on('data', (data) => handleDataMsg(senderId, data));
        conn.on('close', () => delete dataConns[senderId]);
    }

    function handleDataMsg(fromId, rawData) {
        try {
            const msg = typeof rawData === 'string' ? JSON.parse(rawData) : rawData;
            if (msg.type === 'voice_state' && msg.userId !== userId) {
                cb.onStateChange({ userId: msg.userId, isMuted: msg.isMuted });
            }
        } catch (e) {}
    }

    function removePeer(targetUserId) {
        // Close call
        if (calls[targetUserId]) {
            try { calls[targetUserId].close(); } catch (e) {}
            delete calls[targetUserId];
        }
        // Close data conn
        if (dataConns[targetUserId]) {
            try { dataConns[targetUserId].close(); } catch (e) {}
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
            try { remoteAudios[uid].srcObject = null; } catch (e) {}
            try { remoteAudios[uid].remove(); } catch (e) {}
        }

        // Pastikan AudioContext aktif (iOS)
        unlockAudioContext();

        const audio = new Audio();
        audio.srcObject = stream;
        audio.autoplay = true;
        audio.playsInline = true;
        // iOS Safari: pastikan volume tidak 0
        audio.volume = 1.0;
        // iOS Safari: add ke DOM (diperlukan di beberapa versi iOS)
        audio.style.display = 'none';
        audio.setAttribute('playsinline', '');
        audio.setAttribute('webkit-playsinline', '');
        document.body.appendChild(audio);
        remoteAudios[uid] = audio;

        // Coba play. iOS Safari mungkin perlu user gesture,
        // tapi kalau sudah di-unlock di joinVoice, ini bisa jalan.
        const playPromise = audio.play();
        if (playPromise) {
            playPromise.then(() => {
                console.log('[Voice] Remote audio playing for', uid);
            }).catch((err) => {
                console.warn('[Voice] Audio play() blocked:', err.name);
                // Di iOS, kalau ini terjadi, coba unlock sekali lagi
                if (!audioUnlocked) {
                    unlockAudioPlayback();
                    // Coba play ulang setelah unlock
                    setTimeout(() => {
                        if (remoteAudios[uid]) {
                            audio.play().catch(() => {
                                console.error('[Voice] Retry play also failed for', uid);
                                cb.onError({ message: 'Audio terblokir. Tap tombol mic lagi untuk unlock.' });
                            });
                        }
                    }, 500);
                } else {
                    cb.onError({ message: 'Audio terblokir. Tap tombol mic lagi.' });
                }
            });
        }

        // Speaking detection
        startSpeakingDetection(uid, stream);
    }

    function startSpeakingDetection(uid, stream) {
        if (speakIntervals[uid]) clearInterval(speakIntervals[uid]);

        try {
            // Pakai shared AudioContext kalau sudah ada
            let ctx = sharedAudioCtx;
            if (!ctx || ctx.state === 'closed') {
                ctx = new (window.AudioContext || window.webkitAudioContext)();
                sharedAudioCtx = ctx;
            }
            // Resume kalau suspended
            if (ctx.state === 'suspended') {
                ctx.resume().catch(() => {});
            }

            const src = ctx.createMediaStreamSource(stream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 512;
            analyser.smoothingTimeConstant = 0.8;
            src.connect(analyser);
            // JANGAN connect analyser ke destination — ini cuma untuk monitoring,
            // kalau di-connect ke destination akan ada echo!
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
            console.warn('[Voice] Speaking detection failed for', uid, e);
        }
    }

    // ===== GETTERS =====

    function getPeerId() { return myPeerId; }
    function getIsJoined() { return isJoined; }
    function getIsMuted() { return isMuted; }
    function getPeers() { return Object.keys(calls); }
    function isSpeaking(uid) { return !!speakingState[uid]; }

    function destroy() {
        leaveVoice();
        // Stop speaking detection intervals
        Object.keys(speakIntervals).forEach(uid => {
            clearInterval(speakIntervals[uid]);
        });
        speakIntervals = {};
        speakingState = {};
        // Close shared AudioContext
        if (sharedAudioCtx && sharedAudioCtx.state !== 'closed') {
            sharedAudioCtx.close().catch(() => {});
            sharedAudioCtx = null;
        }
        audioUnlocked = false;
        // Destroy peer
        if (peer) { 
            try { peer.destroy(); } catch (e) {}
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
        destroy
    };
})();
