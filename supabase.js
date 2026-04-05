// ===========================================
// SUPABASE CONFIGURATION
// ===========================================
// GANTI DENGAN KREDENSIAL SUPABASE ANDA!

const SUPABASE_URL = "https://qcbdydaxbbhmyjkgvjsd.supabase.co";
const SUPABASE_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFjYmR5ZGF4YmJobXlqa2d2anNkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzQ2ODE5MTIsImV4cCI6MjA5MDI1NzkxMn0.LQ5P7bkHV7eMoETtULGzF4igytZPyZaTMD9WOw8T2U4";

// ===========================================
// SUPABASE CLIENT SETUP
// ===========================================

// Inisialisasi Supabase client
const supabaseClient = window.supabase.createClient(
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
);

// ===========================================
// USER ID MANAGEMENT
// ===========================================

/**
 * Get atau buat user ID unik (disimpan di sessionStorage)
 */
function getUserId() {
  let userId = sessionStorage.getItem("watchparty_user_id");
  if (!userId) {
    userId =
      "user_" + Date.now() + "_" + Math.random().toString(36).substr(2, 9);
    sessionStorage.setItem("watchparty_user_id", userId);
  }
  return userId;
}

/**
 * Simpan bahwa user ini adalah host dari room tertentu
 */
function setAsHost(roomId) {
  sessionStorage.setItem(`watchparty_host_${roomId}`, "true");
}

/**
 * Cek apakah user ini adalah host dari room tertentu
 */
function isHostOfRoom(roomId) {
  return sessionStorage.getItem(`watchparty_host_${roomId}`) === "true";
}

// ===========================================
// HELPER FUNCTIONS
// ===========================================

/**
 * Generate UUID v4
 */
function generateUUID() {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

/**
 * Buat room baru di database
 */
async function createRoom(videoUrl) {
  const roomId = generateUUID();
  const hostId = getUserId();

  const { data, error } = await supabaseClient
    .from("rooms")
    .insert([
      {
        id: roomId,
        video_url: videoUrl,
        current_time_sec: 0,
        status: "pause",
        host_id: hostId,
        updated_at: new Date().toISOString(),
      },
    ])
    .select();

  if (error) {
    console.error("Error creating room:", error);
    throw error;
  }

  // Simpan bahwa user ini adalah host
  setAsHost(roomId);

  return roomId;
}

/**
 * Ambil data room berdasarkan ID
 */
async function getRoom(roomId) {
  const { data, error } = await supabaseClient
    .from("rooms")
    .select("*")
    .eq("id", roomId)
    .single();

  if (error) {
    console.error("Error fetching room:", error);
    throw error;
  }

  return data;
}

/**
 * Cek apakah room sudah expired (>24 jam inactive)
 * Returns: { expired: boolean, remainingMs: number, remainingText: string }
 */
function checkRoomExpiry(roomData) {
  if (!roomData || !roomData.updated_at) {
    return { expired: false, remainingMs: Infinity, remainingText: "" };
  }

  const EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 jam
  const updatedAt = new Date(roomData.updated_at).getTime();
  const now = Date.now();
  const elapsed = now - updatedAt;
  const remaining = EXPIRY_MS - elapsed;

  if (remaining <= 0) {
    return { expired: true, remainingMs: 0, remainingText: "Sudah expired" };
  }

  const remainingText = formatExpiryTime(remaining);
  return { expired: false, remainingMs: remaining, remainingText };
}

/**
 * Format sisa waktu expiry ke teks yang readable
 */
function formatExpiryTime(ms) {
  const hours = Math.floor(ms / (1000 * 60 * 60));
  const minutes = Math.floor((ms % (1000 * 60 * 60)) / (1000 * 60));

  if (hours > 0) {
    return `${hours} jam ${minutes} menit`;
  }
  return `${minutes} menit`;
}

/**
 * Hapus room dari database
 */
async function deleteRoom(roomId) {
  const { error } = await supabaseClient
    .from("rooms")
    .delete()
    .eq("id", roomId);

  if (error) {
    console.error("Error deleting room:", error);
    throw error;
  }

  // Bersihkan data lokal
  localStorage.removeItem(`watchparty_queue_${roomId}`);
  localStorage.removeItem(`watchparty_bookmarks_${roomId}`);
  localStorage.removeItem(`watchparty_chat_${roomId}`);
}

/**
 * Cek apakah user ini adalah host
 */
function checkIsHost(roomData) {
  const userId = getUserId();

  // Cek dari sessionStorage (untuk backward compatibility)
  if (isHostOfRoom(roomData.id)) {
    return true;
  }

  // Cek dari database
  if (roomData.host_id && roomData.host_id === userId) {
    return true;
  }

  // Legacy: kalau host_id belum ada, anggap semua orang bisa kontrol
  if (!roomData.host_id) {
    return true;
  }

  return false;
}

/**
 * Update status room (play/pause) - hanya host yang bisa
 */
async function updateRoomStatus(roomId, status, currentTime) {
  const { error } = await supabaseClient
    .from("rooms")
    .update({
      status: status,
      current_time_sec: currentTime,
      updated_at: new Date().toISOString(),
    })
    .eq("id", roomId);

  if (error) {
    console.error("Error updating room:", error);
    throw error;
  }
}

/**
 * Update waktu video (untuk seek) - hanya host yang bisa
 */
async function updateRoomTime(roomId, currentTime) {
  const { error } = await supabaseClient
    .from("rooms")
    .update({
      current_time_sec: currentTime,
      // updated_at TIDAK diupdate di sini, supaya room bisa expire
      // Hanya updateRoomStatus (play/pause) yang extend expiry
    })
    .eq("id", roomId);

  if (error) {
    console.error("Error updating time:", error);
    throw error;
  }
}

/**
 * Subscribe ke perubahan room
 */
function subscribeToRoom(roomId, callback) {
  const channel = supabaseClient
    .channel(`room:${roomId}`)
    .on(
      "postgres_changes",
      {
        event: "UPDATE",
        schema: "public",
        table: "rooms",
        filter: `id=eq.${roomId}`,
      },
      (payload) => {
        // console.log di-comment untuk performa
        callback(payload.new);
      },
    )
    .subscribe((status) => {
      // console.log di-comment untuk performa
    });

  return channel;
}

/**
 * Unsubscribe dari channel
 */
async function unsubscribeFromRoom(channel) {
  await supabaseClient.removeChannel(channel);
}

// ===========================================
// PRESENCE - TRACK ONLINE VIEWERS
// ===========================================

/**
 * Subscribe to presence channel for viewer tracking
 */
function subscribeToPresence(roomId, userId, isHost, userName, callbacks) {
  const channel = supabaseClient.channel(`presence:${roomId}`, {
    config: {
      presence: {
        key: userId,
      },
    },
  });

  channel
    .on("presence", { event: "sync" }, () => {
      const newState = channel.presenceState();
      if (callbacks && callbacks.onSync) {
        callbacks.onSync(newState);
      }
    })
    .on("presence", { event: "join" }, ({ newPresences }) => {
      if (callbacks && callbacks.onJoin) {
        callbacks.onJoin(newPresences);
      }
    })
    .on("presence", { event: "leave" }, ({ leftPresences }) => {
      if (callbacks && callbacks.onLeave) {
        callbacks.onLeave(leftPresences);
      }
    })
    .subscribe(async (status) => {
      if (status === "SUBSCRIBED") {
        // Track this user with name
        await channel.track({
          user_id: userId,
          user_name: userName || "Guest",
          is_host: isHost,
          joined_at: new Date().toISOString(),
          online: true,
        });
      }
    });

  return channel;
}

/**
 * Update presence status (e.g., when playing/pausing)
 */
async function updatePresence(channel, data) {
  if (channel) {
    await channel.track(data);
  }
}

/**
 * Unsubscribe from presence channel
 */
async function unsubscribeFromPresence(channel) {
  if (channel) {
    await channel.untrack();
    await supabaseClient.removeChannel(channel);
  }
}

// ===========================================
// CHAT - REALTIME MESSAGING
// ===========================================

/**
 * Get chat history from localStorage
 */
function getChatHistory(roomId) {
  const key = `watchparty_chat_${roomId}`;
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      return [];
    }
  }
  return [];
}

/**
 * Save chat message to history
 */
function saveChatMessage(roomId, message) {
  const key = `watchparty_chat_${roomId}`;
  const history = getChatHistory(roomId);
  history.push(message);
  // Keep only last 100 messages
  if (history.length > 100) {
    history.shift();
  }
  localStorage.setItem(key, JSON.stringify(history));
}

/**
 * Clear chat history
 */
function clearChatHistory(roomId) {
  const key = `watchparty_chat_${roomId}`;
  localStorage.removeItem(key);
}

/**
 * Subscribe to chat channel for messaging
 */
function subscribeToChat(roomId, callback) {
  const channel = supabaseClient.channel(`chat:${roomId}`, {
    config: {
      broadcast: { self: false }, // Don't receive own messages
    },
  });

  channel
    .on("broadcast", { event: "message" }, (payload) => {
      // Save to history
      saveChatMessage(roomId, payload.payload);
      if (callback) {
        callback(payload.payload);
      }
    })
    .subscribe();

  return channel;
}

/**
 * Send a chat message
 */
async function sendChatMessage(channel, message) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "message",
      payload: message,
    });
  }
}

/**
 * Unsubscribe from chat channel
 */
async function unsubscribeFromChat(channel) {
  if (channel) {
    await supabaseClient.removeChannel(channel);
  }
}

// ===========================================
// SYNC BROADCAST - INSTANT PLAY/PAUSE SYNC
// ===========================================

/**
 * Subscribe to sync channel for instant play/pause and reactions
 */
function subscribeToSync(roomId, callbacks) {
  const channel = supabaseClient.channel(`sync:${roomId}`, {
    config: {
      broadcast: { self: false },
    },
  });

  channel
    .on("broadcast", { event: "status" }, (payload) => {
      if (callbacks && callbacks.onStatus) {
        callbacks.onStatus(payload.payload);
      }
    })
    .on("broadcast", { event: "reaction" }, (payload) => {
      if (callbacks && callbacks.onReaction) {
        callbacks.onReaction(payload.payload);
      }
    })
    .on("broadcast", { event: "typing" }, (payload) => {
      if (callbacks && callbacks.onTyping) {
        callbacks.onTyping(payload.payload);
      }
    })
    .on("broadcast", { event: "kick" }, (payload) => {
      if (callbacks && callbacks.onKick) {
        callbacks.onKick(payload.payload);
      }
    })
    .on("broadcast", { event: "knock" }, (payload) => {
      if (callbacks && callbacks.onKnock) {
        callbacks.onKnock(payload.payload);
      }
    })
    .on("broadcast", { event: "knock_response" }, (payload) => {
      if (callbacks && callbacks.onKnockResponse) {
        callbacks.onKnockResponse(payload.payload);
      }
    })
    .subscribe();

  return channel;
}

/**
 * Broadcast status change (play/pause) - instant sync
 */
async function broadcastStatus(channel, status, currentTime) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "status",
      payload: {
        status: status,
        currentTime: currentTime,
        timestamp: Date.now(),
      },
    });
  }
}

/**
 * Broadcast reaction - instant sync
 */
async function broadcastReaction(channel, emoji, userName) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "reaction",
      payload: {
        emoji: emoji,
        userName: userName || "Guest",
        timestamp: Date.now(),
      },
    });
  }
}

/**
 * Broadcast kick user - host kicks a guest
 */
async function broadcastKick(channel, targetUserId, kickedBy) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "kick",
      payload: {
        target_user_id: targetUserId,
        kicked_by: kickedBy || "Host",
        timestamp: Date.now(),
      },
    });
  }
}

/**
 * Broadcast knock request - kicked user wants to rejoin
 */
async function broadcastKnock(channel, userId, userName) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "knock",
      payload: {
        user_id: userId,
        user_name: userName || "Guest",
        timestamp: Date.now(),
      },
    });
  }
}

/**
 * Broadcast knock response - host approves or denies
 */
async function broadcastKnockResponse(
  channel,
  targetUserId,
  approved,
  hostName,
) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "knock_response",
      payload: {
        target_user_id: targetUserId,
        approved: approved,
        host_name: hostName || "Host",
        timestamp: Date.now(),
      },
    });
  }
}

/**
 * Unsubscribe from sync channel
 */
async function unsubscribeFromSync(channel) {
  if (channel) {
    await supabaseClient.removeChannel(channel);
  }
}

// ===========================================
// BOOKMARKS - TIMESTAMP BOOKMARKS
// ===========================================

/**
 * Get bookmarks from localStorage
 */
function getBookmarks(roomId) {
  const key = `watchparty_bookmarks_${roomId}`;
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      return [];
    }
  }
  return [];
}

/**
 * Save bookmarks to localStorage
 */
function saveBookmarks(roomId, bookmarks) {
  const key = `watchparty_bookmarks_${roomId}`;
  localStorage.setItem(key, JSON.stringify(bookmarks));
}

/**
 * Add a new bookmark
 */
function addBookmark(roomId, timestamp, label, createdBy) {
  const bookmarks = getBookmarks(roomId);
  const newBookmark = {
    id: "bm_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
    timestamp: timestamp,
    label: label || formatBookmarkTime(timestamp),
    created_by: createdBy || "Guest",
    created_at: Date.now(),
  };
  bookmarks.push(newBookmark);
  // Sort by timestamp
  bookmarks.sort((a, b) => a.timestamp - b.timestamp);
  saveBookmarks(roomId, bookmarks);
  return newBookmark;
}

/**
 * Delete a bookmark
 */
function deleteBookmark(roomId, bookmarkId) {
  const bookmarks = getBookmarks(roomId);
  const filtered = bookmarks.filter((b) => b.id !== bookmarkId);
  saveBookmarks(roomId, filtered);
  return filtered;
}

/**
 * Format timestamp to MM:SS or HH:MM:SS
 */
function formatBookmarkTime(seconds) {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (hrs > 0) {
    return `${hrs}:${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  }
  return `${mins}:${secs.toString().padStart(2, "0")}`;
}

/**
 * Subscribe to bookmark channel for real-time sync
 */
function subscribeToBookmarks(roomId, callback) {
  const channel = supabaseClient.channel(`bookmarks:${roomId}`, {
    config: {
      broadcast: { self: false },
    },
  });

  channel
    .on("broadcast", { event: "bookmark_add" }, (payload) => {
      if (callback && callback.onAdd) {
        callback.onAdd(payload.payload);
      }
    })
    .on("broadcast", { event: "bookmark_delete" }, (payload) => {
      if (callback && callback.onDelete) {
        callback.onDelete(payload.payload);
      }
    })
    .subscribe();

  return channel;
}

/**
 * Broadcast new bookmark
 */
async function broadcastBookmarkAdd(channel, bookmark) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "bookmark_add",
      payload: bookmark,
    });
  }
}

/**
 * Broadcast bookmark deletion
 */
async function broadcastBookmarkDelete(channel, bookmarkId) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "bookmark_delete",
      payload: { id: bookmarkId },
    });
  }
}

/**
 * Unsubscribe from bookmark channel
 */
async function unsubscribeFromBookmarks(channel) {
  if (channel) {
    await supabaseClient.removeChannel(channel);
  }
}

// ===========================================
// QUEUE - VIDEO PLAYLIST
// ===========================================

/**
 * Get queue from localStorage
 */
function getQueue(roomId) {
  const key = `watchparty_queue_${roomId}`;
  const stored = localStorage.getItem(key);
  if (stored) {
    try {
      return JSON.parse(stored);
    } catch (e) {
      return [];
    }
  }
  return [];
}

/**
 * Save queue to localStorage
 */
function saveQueue(roomId, queue) {
  const key = `watchparty_queue_${roomId}`;
  localStorage.setItem(key, JSON.stringify(queue));
}

/**
 * Add video to queue
 */
function addToQueue(roomId, videoUrl, title, addedBy) {
  const queue = getQueue(roomId);
  const newItem = {
    id: "q_" + Date.now() + "_" + Math.random().toString(36).substr(2, 5),
    video_url: videoUrl,
    title: title || extractVideoTitle(videoUrl),
    added_by: addedBy || "Guest",
    added_at: Date.now(),
  };
  queue.push(newItem);
  saveQueue(roomId, queue);
  return newItem;
}

/**
 * Remove video from queue
 */
function removeFromQueue(roomId, itemId) {
  const queue = getQueue(roomId);
  const filtered = queue.filter((item) => item.id !== itemId);
  saveQueue(roomId, filtered);
  return filtered;
}

/**
 * Move item in queue (up or down)
 */
function moveInQueue(roomId, itemId, direction) {
  const queue = getQueue(roomId);
  const index = queue.findIndex((item) => item.id === itemId);

  if (index === -1) return queue;

  if (direction === "up" && index > 0) {
    [queue[index - 1], queue[index]] = [queue[index], queue[index - 1]];
  } else if (direction === "down" && index < queue.length - 1) {
    [queue[index], queue[index + 1]] = [queue[index + 1], queue[index]];
  }

  saveQueue(roomId, queue);
  return queue;
}

/**
 * Get next video in queue
 */
function getNextInQueue(roomId) {
  const queue = getQueue(roomId);
  return queue.length > 0 ? queue[0] : null;
}

/**
 * Remove first item (after playing)
 */
function shiftQueue(roomId) {
  const queue = getQueue(roomId);
  const removed = queue.shift();
  saveQueue(roomId, queue);
  return { removed, queue };
}

/**
 * Extract video title from URL
 */
function extractVideoTitle(url) {
  if (url.includes("youtube.com") || url.includes("youtu.be")) {
    return "YouTube Video";
  }
  // Try to get filename from URL
  try {
    const urlObj = new URL(url);
    const pathname = urlObj.pathname;
    const filename = pathname.split("/").pop();
    if (filename && filename.includes(".")) {
      return filename.substring(0, filename.lastIndexOf(".")) || "Video";
    }
    return "Video";
  } catch (e) {
    return "Video";
  }
}

/**
 * Subscribe to queue channel for real-time sync
 */
function subscribeToQueue(roomId, callback) {
  const channel = supabaseClient.channel(`queue:${roomId}`, {
    config: {
      broadcast: { self: false },
    },
  });

  channel
    .on("broadcast", { event: "queue_add" }, (payload) => {
      if (callback && callback.onAdd) {
        callback.onAdd(payload.payload);
      }
    })
    .on("broadcast", { event: "queue_remove" }, (payload) => {
      if (callback && callback.onRemove) {
        callback.onRemove(payload.payload);
      }
    })
    .on("broadcast", { event: "queue_move" }, (payload) => {
      if (callback && callback.onMove) {
        callback.onMove(payload.payload);
      }
    })
    .on("broadcast", { event: "queue_play_next" }, (payload) => {
      if (callback && callback.onPlayNext) {
        callback.onPlayNext(payload.payload);
      }
    })
    .on("broadcast", { event: "queue_request" }, (payload) => {
      // Host receives request from new user, send full queue
      if (callback && callback.onQueueRequest) {
        callback.onQueueRequest(payload.payload);
      }
    })
    .on("broadcast", { event: "queue_sync" }, (payload) => {
      // Guest receives full queue from host
      if (callback && callback.onQueueSync) {
        callback.onQueueSync(payload.payload);
      }
    })
    .subscribe();

  return channel;
}

/**
 * Broadcast request for full queue (guest asks host)
 */
async function broadcastQueueRequest(channel) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "queue_request",
      payload: { requested_at: Date.now() },
    });
  }
}

/**
 * Broadcast full queue sync (host sends to guests)
 */
async function broadcastQueueSync(channel, queue) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "queue_sync",
      payload: { queue: queue, synced_at: Date.now() },
    });
  }
}

/**
 * Broadcast queue add
 */
async function broadcastQueueAdd(channel, item) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "queue_add",
      payload: item,
    });
  }
}

/**
 * Broadcast queue remove
 */
async function broadcastQueueRemove(channel, itemId) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "queue_remove",
      payload: { id: itemId },
    });
  }
}

/**
 * Broadcast queue move
 */
async function broadcastQueueMove(channel, itemId, direction) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "queue_move",
      payload: { id: itemId, direction: direction },
    });
  }
}

/**
 * Broadcast play next video
 */
async function broadcastPlayNext(channel, videoUrl) {
  if (channel) {
    await channel.send({
      type: "broadcast",
      event: "queue_play_next",
      payload: { video_url: videoUrl },
    });
  }
}

/**
 * Unsubscribe from queue channel
 */
async function unsubscribeFromQueue(channel) {
  if (channel) {
    await supabaseClient.removeChannel(channel);
  }
}

// ===========================================
// BAD WORD FILTER - FILTER BAHASA KOTOR
// ===========================================

/**
 * Kata terlarang yang akan difilter di chat & nama.
 * Daftar: kotor, anjing, babi, memek, ppk, mmk, kntl, anj, ajg
 * Catatan: "anjir" dan "anjay" diizinkan (tidak difilter)
 */
const BAD_WORDS = [
  "kotor",
  "anjing",
  "babi",
  "memek",
  "ppk",
  "mmk",
  "kntl",
  "anj",
  "ajg",
  "pepek",
  "kontol",
  "jembut",
  "perek",
  "puki",
  "ngentot",
  "ngewe",
  "ngewek",
  "pele",
  "pelek",
  "nonok",
  "ewe",
  "ewek",
  "meki",
];

/**
 * Pattern aman — kata yang mengandung "anj" tapi boleh.
 * "anjir" dan "anjay" TIDAK akan difilter meskipun mengandung substring "anj".
 */
const SAFE_ANJ_PATTERNS = [
  "anjir",
  "anjay",
  "anjirr",
  "anjayy",
  "anjirrr",
  "anjayyy",
];

/**
 * Cek apakah teks mengandung kata terlarang.
 * Logic: hapus dulu kata aman (anjir/anjay), baru cek bad words.
 * Returns: { clean: boolean, word?: string }
 */
function containsBadWord(text) {
  if (!text || typeof text !== "string") return { clean: true };
  let lower = text.toLowerCase().trim();

  // 1. Hapus kata aman yang mengandung "anj" supaya ga false positive
  for (const safe of SAFE_ANJ_PATTERNS) {
    lower = lower.split(safe).join("");
  }

  // 2. Cek bad words
  for (const bad of BAD_WORDS) {
    if (lower.includes(bad.toLowerCase())) {
      return { clean: false, word: bad };
    }
  }

  return { clean: true };
}

/**
 * Cek nama — sama seperti containsBadWord, dipakai untuk validasi nama user.
 * Returns: { clean: boolean, word?: string }
 */
function containsBadWordStrict(text) {
  return containsBadWord(text);
}

// Export untuk digunakan di file lain
window.watchParty = {
  supabase: supabaseClient,
  generateUUID,
  getUserId,
  createRoom,
  getRoom,
  deleteRoom,
  updateRoomStatus,
  updateRoomTime,
  subscribeToRoom,
  unsubscribeFromRoom,
  subscribeToPresence,
  updatePresence,
  unsubscribeFromPresence,
  subscribeToChat,
  sendChatMessage,
  unsubscribeFromChat,
  getChatHistory,
  saveChatMessage,
  clearChatHistory,
  subscribeToSync,
  broadcastStatus,
  broadcastReaction,
  broadcastKick,
  broadcastKnock,
  broadcastKnockResponse,
  unsubscribeFromSync,
  checkIsHost,
  checkRoomExpiry,
  formatExpiryTime,
  // Bookmarks
  getBookmarks,
  saveBookmarks,
  addBookmark,
  deleteBookmark,
  formatBookmarkTime,
  subscribeToBookmarks,
  broadcastBookmarkAdd,
  broadcastBookmarkDelete,
  unsubscribeFromBookmarks,
  // Queue
  getQueue,
  saveQueue,
  addToQueue,
  removeFromQueue,
  moveInQueue,
  getNextInQueue,
  shiftQueue,
  extractVideoTitle,
  subscribeToQueue,
  broadcastQueueAdd,
  broadcastQueueRemove,
  broadcastQueueMove,
  broadcastQueueSync,
  broadcastQueueRequest,
  broadcastPlayNext,
  unsubscribeFromQueue,
  SUPABASE_URL,
  SUPABASE_ANON_KEY,
  // Bad Word Filter
  containsBadWord,
  containsBadWordStrict,
};