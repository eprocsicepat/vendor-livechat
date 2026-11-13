import { DurableObject } from "cloudflare:workers";

const SESSION_COOKIE = "vdp_session";
const SESSION_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_MESSAGE = 5000;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

const json = (data, status = 200, extra = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      ...extra,
    },
  });

const error = (message, status = 400) => json({ error: message }, status);
const now = () => Date.now();
const makeId = (prefix = "id") => `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;

function parseCookies(request) {
  const raw = request.headers.get("Cookie") || "";
  return Object.fromEntries(
    raw.split(";").map((part) => {
      const i = part.indexOf("=");
      return i < 0 ? ["", ""] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
    }).filter(([k]) => k)
  );
}

function cookieHeader(token, maxAge = SESSION_TTL / 1000, secure = true) {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax;${secure ? " Secure;" : ""} Max-Age=${maxAge}`;
}

function clearCookieHeader(secure = true) {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax;${secure ? " Secure;" : ""} Max-Age=0`;
}

function bytesToB64(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value) {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

async function sha256(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return bytesToB64(new Uint8Array(digest));
}

async function passwordHash(password, saltB64) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: b64ToBytes(saltB64),
      iterations: 100000,
      hash: "SHA-256",
    },
    key,
    256
  );
  return bytesToB64(new Uint8Array(bits));
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function sameOrigin(request) {
  const origin = request.headers.get("Origin");
  return !origin || origin === new URL(request.url).origin;
}

async function getUser(request, env) {
  const token = parseCookies(request)[SESSION_COOKIE];
  if (!token) return null;
  const tokenHash = await sha256(token);
  const row = await env.DB.prepare(
    `SELECT u.id, u.username, u.name, u.role, u.status
     FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = ? AND s.expires_at > ?`
  ).bind(tokenHash, now()).first();
  if (!row || row.status !== "active") return null;
  return row;
}

async function requireUser(request, env) {
  const user = await getUser(request, env);
  return user || null;
}

function isProcurement(user) {
  return !!user && (user.role === "procurement" || user.role === "admin");
}

async function audit(env, actorId, eventType, targetId = null, projectId = null, reason = null) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, actor_id, event_type, target_id, project_id, reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(makeId("au"), actorId || "system", eventType, targetId, projectId, reason, now()).run();
}

async function authRateLimit(request, env, kind, limit, windowMs) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";
  const cutoff = now() - windowMs;
  const count = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM auth_attempts WHERE ip = ? AND kind = ? AND created_at > ?`
  ).bind(ip, kind, cutoff).first();
  if ((count?.n || 0) >= limit) return false;
  await env.DB.prepare(
    `INSERT INTO auth_attempts (id, ip, kind, created_at) VALUES (?, ?, ?, ?)`
  ).bind(makeId("at"), ip, kind, now()).run();
  await env.DB.prepare(`DELETE FROM auth_attempts WHERE created_at < ?`).bind(now() - 24 * 60 * 60 * 1000).run();
  return true;
}

async function createSession(userId, env) {
  const tokenBytes = crypto.getRandomValues(new Uint8Array(32));
  const token = bytesToB64(tokenBytes).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  const tokenHash = await sha256(token);
  const createdAt = now();
  await env.DB.prepare(
    `INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`
  ).bind(tokenHash, userId, createdAt, createdAt + SESSION_TTL).run();
  return token;
}

async function needsSetup(env) {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM users WHERE role = 'admin'`).first();
  return (row?.n || 0) === 0;
}

async function joinProject(env, projectId, user) {
  if (user.role !== "vendor") return null;
  const found = await env.DB.prepare(
    `SELECT id, alias FROM participants WHERE project_id = ? AND user_id = ?`
  ).bind(projectId, user.id).first();
  if (found) return found;

  for (let attempt = 0; attempt < 8; attempt++) {
    const count = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM participants WHERE project_id = ?`
    ).bind(projectId).first();
    const alias = `Vendor ${String((count?.n || 0) + 1 + attempt).padStart(2, "0")}`;
    const id = makeId("pa");
    try {
      await env.DB.prepare(
        `INSERT INTO participants (id, project_id, user_id, alias, joined_at)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(id, projectId, user.id, alias, now()).run();
      await audit(env, user.id, "project_join", projectId, projectId);
      return { id, alias };
    } catch (err) {
      const retry = await env.DB.prepare(
        `SELECT id, alias FROM participants WHERE project_id = ? AND user_id = ?`
      ).bind(projectId, user.id).first();
      if (retry) return retry;
      if (attempt === 7) throw err;
    }
  }
  throw new Error("Tidak dapat membuat alias peserta.");
}

async function getTopicContext(env, topicId) {
  return env.DB.prepare(
    `SELECT t.id AS topic_id, t.title AS topic_title, t.status AS topic_status,
            p.id AS project_id, p.name AS project_name, p.status AS project_status
     FROM topics t JOIN projects p ON p.id = t.project_id
     WHERE t.id = ?`
  ).bind(topicId).first();
}

async function canReadContext(context, user) {
  if (!context || !user || user.status !== "active") return false;
  return isProcurement(user) || (user.role === "vendor" && context.project_status === "open");
}

async function broadcast(env, topicId, event) {
  const id = env.CHAT_ROOMS.idFromName(topicId);
  const stub = env.CHAT_ROOMS.get(id);
  await stub.fetch("https://chat-room.internal/broadcast", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(event),
  });
}

async function revokeUserConnections(env, userId) {
  const rows = await env.DB.prepare(`SELECT id AS topic_id FROM topics`).all();
  for (const row of rows.results || []) {
    await broadcast(env, row.topic_id, { type: "revoke_user", userId });
  }
  const conversations = await env.DB.prepare(
    "SELECT id FROM support_conversations WHERE vendor_id = ? OR assigned_to = ?"
  ).bind(userId, userId).all();
  for (const row of conversations.results || []) {
    await broadcast(env, "support:" + row.id, { type: "revoke_user", userId });
  }
  await broadcast(env, "support_inbox", { type: "revoke_user", userId });
}

async function listProjects(env) {
  const result = await env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.category, p.period, p.status, p.created_at,
       (SELECT COUNT(*) FROM topics t WHERE t.project_id = p.id) AS topic_count,
       (SELECT COUNT(*) FROM messages m WHERE m.project_id = p.id AND m.visibility = 'visible') AS message_count,
       COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.project_id = p.id AND m.visibility = 'visible'), p.created_at) AS last_activity
     FROM projects p ORDER BY p.created_at DESC`
  ).all();
  return result.results || [];
}

async function getProject(env, projectId) {
  return env.DB.prepare(
    `SELECT p.id, p.name, p.description, p.category, p.period, p.status, p.created_at,
       (SELECT COUNT(*) FROM participants pa WHERE pa.project_id = p.id) AS participant_count,
       (SELECT COUNT(*) FROM messages m WHERE m.project_id = p.id AND m.visibility = 'visible') AS message_count
     FROM projects p WHERE p.id = ?`
  ).bind(projectId).first();
}

async function listTopics(env, projectId) {
  const result = await env.DB.prepare(
    `SELECT t.id, t.project_id, t.title, t.description, t.status, t.created_at, t.sort_order,
       (SELECT COUNT(*) FROM messages m WHERE m.topic_id = t.id AND m.visibility = 'visible') AS message_count,
       COALESCE((SELECT MAX(m.created_at) FROM messages m WHERE m.topic_id = t.id AND m.visibility = 'visible'), t.created_at) AS last_activity
     FROM topics t WHERE t.project_id = ? ORDER BY t.sort_order, t.created_at`
  ).bind(projectId).all();
  return result.results || [];
}

async function filesForMessage(env, messageId, user) {
  const rows = await env.DB.prepare(
    `SELECT id, name, mime, size, access, owner_id, created_at
     FROM files WHERE message_id = ? ORDER BY created_at`
  ).bind(messageId).all();
  return (rows.results || [])
    .filter((file) => isProcurement(user) || file.access === "shared" || file.owner_id === user.id)
    .map(({ owner_id, ...file }) => file);
}

async function formatMessages(env, context, user) {
  const where = isProcurement(user) ? "" : " AND m.visibility = 'visible'";
  const rows = await env.DB.prepare(
    `SELECT m.id, m.body, m.reply_to, m.visibility, m.mod_reason, m.created_at,
            u.id AS sender_id, u.name AS sender_name, u.role AS sender_role,
            pa.alias AS sender_alias, u.status AS sender_status
     FROM messages m
     JOIN users u ON u.id = m.sender_id
     LEFT JOIN participants pa ON pa.project_id = m.project_id AND pa.user_id = m.sender_id
     WHERE m.topic_id = ? ${where}
     ORDER BY m.created_at ASC LIMIT 500`
  ).bind(context.topic_id).all();

  const messages = [];
  for (const row of rows.results || []) {
    const vendor = row.sender_role === "vendor";
    const message = {
      id: row.id,
      body: row.body,
      replyTo: row.reply_to,
      visibility: row.visibility,
      modReason: isProcurement(user) ? row.mod_reason : null,
      createdAt: row.created_at,
      senderLabel: vendor ? (row.sender_alias || "Vendor") : row.sender_name,
      senderRole: vendor ? "vendor" : "procurement",
      isMine: row.sender_id === user.id,
      files: await filesForMessage(env, row.id, user),
    };
    if (isProcurement(user)) message.senderCompany = vendor ? row.sender_name : null;
    messages.push(message);
  }
  return messages;
}

async function handleFileDownload(request, env, user, fileId) {
  if (!env.FILES) return error("Penyimpanan lampiran belum diaktifkan. Chat teks tetap tersedia.", 503);
  const file = await env.DB.prepare(
    `SELECT f.*, p.status AS project_status
     FROM files f JOIN projects p ON p.id = f.project_id WHERE f.id = ?`
  ).bind(fileId).first();
  if (!file) return error("File tidak ditemukan.", 404);
  if (!isProcurement(user)) {
    if (user.role !== "vendor" || file.project_status !== "open") return error("Akses file ditolak.", 403);
    if (file.access !== "shared" && file.owner_id !== user.id) return error("File ini bersifat privat.", 403);
  }
  const object = await env.FILES.get(file.object_key);
  if (!object) return error("Objek file tidak ditemukan.", 404);
  const originalName = String(file.name).replace(/[\r\n]/g, "_");
  const safeName = originalName.replace(/[^\x20-\x7E"]/g, "_").replace(/"/g, "_");
  const encodedName = encodeURIComponent(originalName);
  return new Response(object.body, {
    headers: {
      "content-type": "application/octet-stream",
      "content-length": String(file.size),
      "content-disposition": `attachment; filename="${safeName}"; filename*=UTF-8''${encodedName}`,
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function allowedUpload(file) {
  const name = String(file?.name || "").toLowerCase();
  return /\.(pdf|doc|docx|xls|xlsx|ppt|pptx|csv|txt|md|jpg|jpeg|png|zip)$/i.test(name);
}

async function uploadR2File(env, file, projectId, topicId, messageId, owner, access, originalFileId = null) {
  const id = makeId("f");
  const objectKey = `${projectId}/${topicId || "project"}/${id}`;
  const cleanName = String(file.name || "attachment").replace(/[\/\\\r\n]/g, "_").slice(0, 180);
  await env.FILES.put(objectKey, file.stream(), {
    httpMetadata: { contentType: file.type || "application/octet-stream" },
    customMetadata: { originalName: cleanName },
  });
  try {
    await env.DB.prepare(
      `INSERT INTO files
       (id, project_id, topic_id, message_id, owner_id, name, mime, size, object_key, access, original_file_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, projectId, topicId, messageId, owner.id, cleanName,
      file.type || "application/octet-stream", file.size, objectKey, access, originalFileId, now()
    ).run();
  } catch (err) {
    await env.FILES.delete(objectKey);
    throw err;
  }
  return {
    id, name: cleanName, mime: file.type || "application/octet-stream",
    size: file.size, access, createdAt: now(),
  };
}

async function categoryRows(env, includeInactive = false) {
  const result = await env.DB.prepare(
    "SELECT c.id, c.name, c.is_active, c.sort_order, COUNT(p.id) AS usage_count " +
    "FROM categories c LEFT JOIN projects p ON p.category = c.name " +
    "WHERE (? = 1 OR c.is_active = 1) GROUP BY c.id " +
    "ORDER BY c.sort_order, c.name COLLATE NOCASE"
  ).bind(includeInactive ? 1 : 0).all();
  return result.results || [];
}

async function getSupportConversation(env, conversationId) {
  return env.DB.prepare(
    "SELECT c.id, c.vendor_id, c.assigned_to, c.status, c.created_at, c.updated_at, " +
    "c.last_message_at, c.first_agent_reply_at, c.closed_at, " +
    "v.name AS vendor_name, v.username AS vendor_username, a.name AS assigned_name " +
    "FROM support_conversations c JOIN users v ON v.id = c.vendor_id " +
    "LEFT JOIN users a ON a.id = c.assigned_to WHERE c.id = ?"
  ).bind(conversationId).first();
}

async function getSupportMessages(env, conversationId) {
  const result = await env.DB.prepare(
    "SELECT m.id, m.conversation_id, m.sender_id, m.sender_role, m.body, m.created_at, u.name AS sender_name " +
    "FROM support_messages m JOIN users u ON u.id = m.sender_id " +
    "WHERE m.conversation_id = ? ORDER BY m.created_at, m.id LIMIT 500"
  ).bind(conversationId).all();
  return result.results || [];
}

async function supportHistory(env, vendorId) {
  const result = await env.DB.prepare(
    "SELECT c.id, c.status, c.assigned_to, c.created_at, c.updated_at, c.last_message_at, " +
    "a.name AS assigned_name, " +
    "(SELECT body FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message, " +
    "(SELECT COUNT(*) FROM support_messages m WHERE m.conversation_id = c.id) AS message_count " +
    "FROM support_conversations c LEFT JOIN users a ON a.id = c.assigned_to " +
    "WHERE c.vendor_id = ? ORDER BY COALESCE(c.last_message_at, c.created_at) DESC LIMIT 20"
  ).bind(vendorId).all();
  return result.results || [];
}

async function supportBroadcast(env, roomName, event) {
  try {
    await broadcast(env, roomName, event);
  } catch (err) {
    console.warn("Support chat broadcast failed:", err);
  }
}

async function supportPresence(env, userId) {
  const row = await env.DB.prepare(
    "SELECT status, updated_at FROM support_agents WHERE user_id = ?"
  ).bind(userId).first();
  if (!row || row.updated_at < now() - 90000) return "offline";
  return row.status;
}

async function markSupportAgentOffline(env, userId) {
  await env.DB.prepare(
    "UPDATE support_agents SET status = 'offline', updated_at = ? WHERE user_id = ?"
  ).bind(now(), userId).run();
  const assigned = await env.DB.prepare(
    "SELECT id FROM support_conversations WHERE assigned_to = ? AND status = 'active'"
  ).bind(userId).all();
  await env.DB.prepare(
    "UPDATE support_conversations SET assigned_to = NULL, status = 'waiting', updated_at = ? WHERE assigned_to = ? AND status = 'active'"
  ).bind(now(), userId).run();
  for (const row of assigned.results || []) {
    await supportBroadcast(env, "support:" + row.id, { type: "support_assignment", status: "waiting" });
    await supportBroadcast(env, "support_inbox", { type: "support_inbox_update", conversationId: row.id });
  }
  await dispatchWaitingSupport(env);
}

async function releaseStaleSupportAgents(env) {
  const stale = await env.DB.prepare(
    "SELECT c.id, c.assigned_to FROM support_conversations c LEFT JOIN support_agents a ON a.user_id = c.assigned_to " +
    "WHERE c.status = 'active' AND c.assigned_to IS NOT NULL AND (a.user_id IS NULL OR a.status = 'offline' OR a.updated_at < ?)"
  ).bind(now() - 90000).all();
  for (const row of stale.results || []) {
    await env.DB.prepare(
      "UPDATE support_conversations SET assigned_to = NULL, status = 'waiting', updated_at = ? WHERE id = ? AND assigned_to = ? AND status = 'active'"
    ).bind(now(), row.id, row.assigned_to).run();
    await supportBroadcast(env, "support:" + row.id, { type: "support_assignment", status: "waiting" });
    await supportBroadcast(env, "support_inbox", { type: "support_inbox_update", conversationId: row.id });
  }
}

async function dispatchWaitingSupport(env) {
  const waiting = await env.DB.prepare(
    "SELECT id FROM support_conversations WHERE status = 'waiting' AND assigned_to IS NULL ORDER BY created_at, id"
  ).all();
  for (const row of waiting.results || []) {
    const agent = await env.DB.prepare(
      "SELECT u.id FROM users u JOIN support_agents a ON a.user_id = u.id " +
      "WHERE u.role IN ('procurement', 'admin') AND u.status = 'active' AND a.status = 'online' AND a.updated_at >= ? " +
      "ORDER BY (SELECT COUNT(*) FROM support_conversations c WHERE c.assigned_to = u.id AND c.status = 'active'), u.name LIMIT 1"
    ).bind(now() - 90000).first();
    if (!agent) break;
    const assignedAt = now();
    const result = await env.DB.prepare(
      "UPDATE support_conversations SET assigned_to = ?, status = 'active', updated_at = ? WHERE id = ? AND status = 'waiting' AND assigned_to IS NULL"
    ).bind(agent.id, assignedAt, row.id).run();
    if (result.meta?.changes) {
      await supportBroadcast(env, "support:" + row.id, { type: "support_assignment", status: "active", agentId: agent.id });
      await supportBroadcast(env, "support_inbox", { type: "support_inbox_update", conversationId: row.id });
    }
  }
}

async function routeApi(request, env) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method.toUpperCase();

  if ((method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() === "websocket") && !sameOrigin(request)) {
    return error("Origin tidak valid.", 403);
  }

  if (path === "/api/health" && method === "GET") {
    return json({ ok: true, service: "vendor-discussion-livechat", timestamp: now() });
  }

  if (path === "/api/session" && method === "GET") {
    const user = await getUser(request, env);
    return json({ user, needsSetup: await needsSetup(env) });
  }

  if (path === "/api/setup" && method === "POST") {
    if (!(await needsSetup(env))) return error("Setup admin sudah pernah dilakukan.", 409);
    if (!env.SETUP_SECRET) return error("SETUP_SECRET belum dikonfigurasi di Cloudflare.", 503);
    const body = await request.json().catch(() => ({}));
    if (!constantTimeEqual(String(body.secret || ""), env.SETUP_SECRET)) return error("Setup secret salah.", 403);
    const username = String(body.username || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return error("Username admin harus 3–30 karakter: huruf, angka, titik, strip, underscore.");
    if (name.length < 3 || name.length > 100) return error("Nama admin harus 3–100 karakter.");
    if (password.length < 12) return error("Password admin minimal 12 karakter.");
    const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    const passHash = await passwordHash(password, salt);
    const id = makeId("u");
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, username, name, password_hash, password_salt, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?)`
      ).bind(id, username, name, passHash, salt, now()).run();
    } catch {
      return error("Username sudah digunakan atau admin gagal dibuat.", 409);
    }
    const token = await createSession(id, env);
    await audit(env, id, "admin_setup", id);
    return json({ user: { id, username, name, role: "admin", status: "active" } }, 201, {
      "set-cookie": cookieHeader(token, SESSION_TTL / 1000, new URL(request.url).protocol === "https:"),
    });
  }

  if (path === "/api/register" && method === "POST") {
    if (!(await authRateLimit(request, env, "register", 5, 60 * 60 * 1000))) {
      return error("Batas registrasi tercapai. Coba kembali nanti.", 429);
    }
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || "").trim().toLowerCase();
    const name = String(body.company || body.name || "").trim();
    const password = String(body.password || "");
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return error("Username harus 3–30 karakter: huruf, angka, titik, strip, underscore.");
    if (name.length < 3 || name.length > 120) return error("Nama perusahaan harus 3–120 karakter.");
    if (password.length < 10) return error("Password minimal 10 karakter.");
    const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    const passHash = await passwordHash(password, salt);
    const id = makeId("u");
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, username, name, password_hash, password_salt, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'vendor', 'active', ?)`
      ).bind(id, username, name, passHash, salt, now()).run();
    } catch {
      return error("Username sudah terdaftar.", 409);
    }
    const token = await createSession(id, env);
    await audit(env, id, "vendor_register", id);
    return json({ user: { id, username, name, role: "vendor", status: "active" } }, 201, {
      "set-cookie": cookieHeader(token, SESSION_TTL / 1000, new URL(request.url).protocol === "https:"),
    });
  }

  if (path === "/api/login" && method === "POST") {
    if (!(await authRateLimit(request, env, "login", 20, 10 * 60 * 1000))) {
      return error("Terlalu banyak percobaan login. Coba kembali dalam beberapa menit.", 429);
    }
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || "").trim().toLowerCase();
    const password = String(body.password || "");
    const userRow = await env.DB.prepare(
      `SELECT id, username, name, password_hash, password_salt, role, status
       FROM users WHERE username = ?`
    ).bind(username).first();
    if (!userRow) return error("Username atau password salah.", 401);
    const candidate = await passwordHash(password, userRow.password_salt);
    if (!constantTimeEqual(candidate, userRow.password_hash)) return error("Username atau password salah.", 401);
    if (userRow.status !== "active") return error("Akun tidak aktif. Hubungi Procurement.", 403);
    const token = await createSession(userRow.id, env);
    await env.DB.prepare(`UPDATE users SET last_login = ? WHERE id = ?`).bind(now(), userRow.id).run();
    await audit(env, userRow.id, "login", userRow.id);
    return json({
      user: {
        id: userRow.id, username: userRow.username, name: userRow.name,
        role: userRow.role, status: userRow.status,
      },
    }, 200, { "set-cookie": cookieHeader(token) });
  }

  if (path === "/api/logout" && method === "POST") {
    const token = parseCookies(request)[SESSION_COOKIE];
    if (token) {
      const tokenHash = await sha256(token);
      const session = await env.DB.prepare(`SELECT user_id FROM sessions WHERE token_hash = ?`).bind(tokenHash).first();
      await env.DB.prepare(`DELETE FROM sessions WHERE token_hash = ?`).bind(tokenHash).run();
      if (session?.user_id) {
        await markSupportAgentOffline(env, session.user_id);
        await revokeUserConnections(env, session.user_id);
      }
    }
    return json({ ok: true }, 200, { "set-cookie": clearCookieHeader(new URL(request.url).protocol === "https:") });
  }

  if (path === "/api/categories" && method === "GET") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat melihat kategori aktif.", 403);
    return json({ categories: await categoryRows(env, false) });
  }

  if (path === "/api/admin/categories" && method === "GET") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "admin") return error("Hanya Super Admin yang dapat mengelola kategori.", 403);
    return json({ categories: await categoryRows(env, true) });
  }

  if (path === "/api/admin/categories" && method === "POST") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "admin") return error("Hanya Super Admin yang dapat mengelola kategori.", 403);
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    if (name.length < 2 || name.length > 80) return error("Nama kategori harus 2–80 karakter.");
    const duplicate = await env.DB.prepare("SELECT id FROM categories WHERE name = ? COLLATE NOCASE").bind(name).first();
    if (duplicate) return error("Nama kategori sudah digunakan.", 409);
    const order = await env.DB.prepare("SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM categories").first();
    const id = makeId("cat");
    await env.DB.prepare(
      "INSERT INTO categories (id, name, is_active, sort_order, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)"
    ).bind(id, name, order?.n || 1, now(), now()).run();
    await audit(env, user.id, "category_create", id, null, name);
    return json({ category: { id, name, is_active: 1, sort_order: order?.n || 1, usage_count: 0 } }, 201);
  }

  if (path === "/api/admin/categories/reorder" && method === "POST") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "admin") return error("Hanya Super Admin yang dapat mengelola kategori.", 403);
    const body = await request.json().catch(() => ({}));
    const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
    const current = await env.DB.prepare("SELECT id FROM categories ORDER BY sort_order, name").all();
    const existing = (current.results || []).map(row => row.id);
    if (ids.length !== existing.length || new Set(ids).size !== existing.length || ids.some(id => !existing.includes(id))) {
      return error("Daftar urutan kategori tidak valid.");
    }
    await env.DB.batch(ids.map((id, index) =>
      env.DB.prepare("UPDATE categories SET sort_order = ?, updated_at = ? WHERE id = ?").bind(index + 1, now(), id)
    ));
    await audit(env, user.id, "category_reorder", null, null, "Kategori diurutkan ulang.");
    return json({ categories: await categoryRows(env, true) });
  }

  const categoryMatch = path.match(/^\/api\/admin\/categories\/([^/]+)$/);
  if (categoryMatch && method === "PATCH") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "admin") return error("Hanya Super Admin yang dapat mengelola kategori.", 403);
    const categoryId = decodeURIComponent(categoryMatch[1]);
    const category = await env.DB.prepare("SELECT id, name, is_active, sort_order FROM categories WHERE id = ?").bind(categoryId).first();
    if (!category) return error("Kategori tidak ditemukan.", 404);
    const body = await request.json().catch(() => ({}));
    const name = body.name === undefined ? category.name : String(body.name || "").trim();
    const active = body.is_active === undefined ? category.is_active : (body.is_active ? 1 : 0);
    const order = body.sort_order === undefined ? category.sort_order : Number(body.sort_order);
    if (name.length < 2 || name.length > 80) return error("Nama kategori harus 2–80 karakter.");
    if (!Number.isInteger(order) || order < 1 || order > 10000) return error("Urutan kategori tidak valid.");
    if (name !== category.name) {
      const duplicate = await env.DB.prepare("SELECT id FROM categories WHERE name = ? COLLATE NOCASE AND id <> ?").bind(name, categoryId).first();
      if (duplicate) return error("Nama kategori sudah digunakan.", 409);
    }
    if (!active && category.is_active) {
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE is_active = 1").first();
      if ((count?.n || 0) <= 1) return error("Minimal satu kategori harus tetap aktif.", 409);
    }
    const statements = [
      env.DB.prepare("UPDATE categories SET name = ?, is_active = ?, sort_order = ?, updated_at = ? WHERE id = ?")
        .bind(name, active, order, now(), categoryId),
    ];
    if (name !== category.name) {
      statements.push(env.DB.prepare("UPDATE projects SET category = ? WHERE category = ?").bind(name, category.name));
    }
    await env.DB.batch(statements);
    await audit(env, user.id, "category_update", categoryId, null, "Kategori diperbarui.");
    return json({ category: await env.DB.prepare("SELECT id, name, is_active, sort_order FROM categories WHERE id = ?").bind(categoryId).first() });
  }

  if (categoryMatch && method === "DELETE") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "admin") return error("Hanya Super Admin yang dapat mengelola kategori.", 403);
    const categoryId = decodeURIComponent(categoryMatch[1]);
    const category = await env.DB.prepare("SELECT id, name, is_active FROM categories WHERE id = ?").bind(categoryId).first();
    if (!category) return error("Kategori tidak ditemukan.", 404);
    const usage = await env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE category = ?").bind(category.name).first();
    const inUse = usage?.n || 0;
    const body = await request.json().catch(() => ({}));
    let replacement = null;
    if (inUse > 0) {
      const replacementId = String(body.replacementId || "");
      if (!replacementId) return error("Kategori sedang digunakan. Pilih kategori pengganti.", 409);
      replacement = await env.DB.prepare("SELECT id, name, is_active FROM categories WHERE id = ?").bind(replacementId).first();
      if (!replacement || replacement.id === category.id || !replacement.is_active) {
        return error("Kategori pengganti harus berbeda dan berstatus aktif.");
      }
    }
    if (category.is_active) {
      const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM categories WHERE is_active = 1").first();
      if ((count?.n || 0) <= 1) return error("Minimal satu kategori harus tetap aktif.", 409);
    }
    const statements = [];
    if (replacement) {
      statements.push(env.DB.prepare("UPDATE projects SET category = ? WHERE category = ?").bind(replacement.name, category.name));
    }
    statements.push(env.DB.prepare("DELETE FROM categories WHERE id = ?").bind(categoryId));
    await env.DB.batch(statements);
    await audit(env, user.id, "category_delete", categoryId, null, replacement ? ("Diganti ke " + replacement.name) : "Kategori dihapus.");
    return json({ ok: true, movedProjects: inUse, replacement: replacement?.name || null });
  }

  if (path === "/api/workspace/topics" && method === "GET") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Workspace hanya tersedia untuk Procurement.", 403);
    const result = await env.DB.prepare(
      "SELECT t.id AS topic_id, t.title AS topic_title, t.description AS topic_description, t.status AS topic_status, " +
      "p.id AS project_id, p.name AS project_name, p.status AS project_status, " +
      "(SELECT COUNT(*) FROM messages mc WHERE mc.topic_id = t.id AND mc.visibility = 'visible') AS message_count, " +
      "(SELECT MAX(ml.created_at) FROM messages ml WHERE ml.topic_id = t.id AND ml.visibility = 'visible') AS last_activity, " +
      "(SELECT ml.body FROM messages ml WHERE ml.topic_id = t.id AND ml.visibility = 'visible' ORDER BY ml.created_at DESC, ml.id DESC LIMIT 1) AS last_message " +
      "FROM topics t JOIN projects p ON p.id = t.project_id " +
      "WHERE EXISTS (SELECT 1 FROM messages m WHERE m.topic_id = t.id AND m.visibility = 'visible') " +
      "ORDER BY last_activity DESC, t.title COLLATE NOCASE"
    ).all();
    return json({ topics: result.results || [] });
  }

  if (path === "/api/projects" && method === "GET") {
    return json({ projects: await listProjects(env) });
  }

  if (path === "/api/projects" && method === "POST") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat membuat project.", 403);
    const body = await request.json().catch(() => ({}));
    const name = String(body.name || "").trim();
    const description = String(body.description || "").trim();
    const category = String(body.category || "Lainnya").trim();
    const period = String(body.period || "").trim();
    if (name.length < 5 || name.length > 160 || !description || description.length > 2000 || !period) {
      return error("Lengkapi nama, deskripsi, dan periode project.");
    }
    const categoryRow = await env.DB.prepare("SELECT name FROM categories WHERE name = ? COLLATE NOCASE AND is_active = 1").bind(category).first();
    if (!categoryRow) return error("Pilih kategori aktif dari daftar.");
    const id = makeId("p");
    await env.DB.prepare(
      `INSERT INTO projects (id, name, description, category, period, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
    ).bind(id, name, description, categoryRow.name, period, user.id, now()).run();
    await audit(env, user.id, "project_create", id, id);
    return json({ project: await getProject(env, id) }, 201);
  }

  const projectMatch = path.match(/^\/api\/projects\/([^/]+)$/);
  if (projectMatch && method === "GET") {
    const projectId = decodeURIComponent(projectMatch[1]);
    const project = await getProject(env, projectId);
    if (!project) return error("Project tidak ditemukan.", 404);
    const user = await getUser(request, env);
    const participant = user?.role === "vendor" && project.status === "open"
      ? await joinProject(env, projectId, user)
      : null;
    return json({ project, topics: await listTopics(env, projectId), myAlias: participant?.alias || null });
  }

  const projectStatusMatch = path.match(/^\/api\/projects\/([^/]+)\/status$/);
  if (projectStatusMatch && method === "PATCH") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat mengubah status project.", 403);
    const projectId = decodeURIComponent(projectStatusMatch[1]);
    const project = await getProject(env, projectId);
    if (!project) return error("Project tidak ditemukan.", 404);
    const body = await request.json().catch(() => ({}));
    if (!["open", "closed"].includes(body.status)) return error("Status project tidak valid.");
    await env.DB.prepare(`UPDATE projects SET status = ? WHERE id = ?`).bind(body.status, projectId).run();
    await audit(env, user.id, body.status === "closed" ? "project_close" : "project_reopen", projectId, projectId);
    const topics = await listTopics(env, projectId);
    for (const topic of topics) await broadcast(env, topic.id, { type: "project_status", status: body.status });
    return json({ project: await getProject(env, projectId) });
  }

  const projectTopicsMatch = path.match(/^\/api\/projects\/([^/]+)\/topics$/);
  if (projectTopicsMatch && method === "POST") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat membuat topik.", 403);
    const projectId = decodeURIComponent(projectTopicsMatch[1]);
    const project = await getProject(env, projectId);
    if (!project) return error("Project tidak ditemukan.", 404);
    if (project.status !== "open") return error("Project Closed tidak menerima topik baru.", 403);
    const body = await request.json().catch(() => ({}));
    const title = String(body.title || "").trim();
    const description = String(body.description || "").trim();
    if (title.length < 4 || title.length > 160 || !description || description.length > 1200) {
      return error("Lengkapi judul dan deskripsi topik.");
    }
    const sort = await env.DB.prepare(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM topics WHERE project_id = ?`).bind(projectId).first();
    const id = makeId("t");
    await env.DB.prepare(
      `INSERT INTO topics (id, project_id, title, description, status, created_by, created_at, sort_order)
       VALUES (?, ?, ?, ?, 'open', ?, ?, ?)`
    ).bind(id, projectId, title, description, user.id, now(), sort?.n || 1).run();
    await audit(env, user.id, "topic_create", id, projectId);
    return json({ topic: { id, project_id: projectId, title, description, status: "open", message_count: 0 } }, 201);
  }

  const topicStatusMatch = path.match(/^\/api\/topics\/([^/]+)\/status$/);
  if (topicStatusMatch && method === "PATCH") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat mengubah status topik.", 403);
    const topicId = decodeURIComponent(topicStatusMatch[1]);
    const context = await getTopicContext(env, topicId);
    if (!context) return error("Topik tidak ditemukan.", 404);
    const body = await request.json().catch(() => ({}));
    if (!["open", "closed"].includes(body.status)) return error("Status topik tidak valid.");
    await env.DB.prepare(`UPDATE topics SET status = ? WHERE id = ?`).bind(body.status, topicId).run();
    await audit(env, user.id, "topic_status", topicId, context.project_id);
    await broadcast(env, topicId, { type: "topic_status", status: body.status });
    return json({ ok: true, status: body.status });
  }

  const topicMessagesMatch = path.match(/^\/api\/topics\/([^/]+)\/messages$/);
  if (topicMessagesMatch && method === "GET") {
    const user = await requireUser(request, env);
    if (!user) return error("Silakan login untuk membaca percakapan.", 401);
    const topicId = decodeURIComponent(topicMessagesMatch[1]);
    const context = await getTopicContext(env, topicId);
    if (!(await canReadContext(context, user))) return error("Project ditutup atau akses tidak tersedia.", 403);
    const participant = user.role === "vendor" ? await joinProject(env, context.project_id, user) : null;
    return json({
      context: {
        topicId: context.topic_id, topicTitle: context.topic_title, topicStatus: context.topic_status,
        projectId: context.project_id, projectName: context.project_name, projectStatus: context.project_status,
        myAlias: participant?.alias || null,
      },
      messages: await formatMessages(env, context, user),
    });
  }

  if (topicMessagesMatch && method === "POST") {
    const user = await requireUser(request, env);
    if (!user) return error("Silakan login untuk mengirim pesan.", 401);
    const topicId = decodeURIComponent(topicMessagesMatch[1]);
    const context = await getTopicContext(env, topicId);
    if (!context) return error("Topik tidak ditemukan.", 404);
    if (context.project_status !== "open") return error("Project Closed. Vendor tidak dapat mengirim pesan.", 403);
    if (user.role === "vendor" && context.topic_status !== "open") return error("Topik ditutup oleh Procurement.", 403);
    if (user.role === "vendor") await joinProject(env, context.project_id, user);
    else if (!isProcurement(user)) return error("Akses menulis tidak tersedia.", 403);

    const form = await request.formData();
    const body = String(form.get("body") || "").trim();
    const uploads = form.getAll("files").filter((file) => file && typeof file === "object" && "size" in file && file.size > 0);
    if (uploads.length && !env.FILES) return error("Upload lampiran sementara dinonaktifkan. Silakan kirim pesan teks.", 503);
    if (!body && !uploads.length) return error("Pesan atau lampiran wajib diisi.");
    if (body.length > MAX_MESSAGE) return error(`Pesan maksimal ${MAX_MESSAGE} karakter.`);
    if (uploads.length > MAX_FILES) return error(`Maksimal ${MAX_FILES} lampiran per pesan.`);
    for (const file of uploads) {
      if (file.size > MAX_FILE_BYTES) return error("Ukuran setiap lampiran maksimal 2 MB.");
      if (!allowedUpload(file)) return error("Format file tidak diizinkan. Gunakan PDF, Office, CSV, TXT, JPG, PNG, atau ZIP.");
    }

    const replyTo = String(form.get("replyTo") || "") || null;
    if (replyTo) {
      const parent = await env.DB.prepare(
        `SELECT id FROM messages WHERE id = ? AND topic_id = ?`
      ).bind(replyTo, topicId).first();
      if (!parent) return error("Pesan yang dibalas tidak ditemukan di topik ini.", 400);
    }
    const messageId = makeId("m");
    const createdAt = now();
    const uploaded = [];
    await env.DB.prepare(
      `INSERT INTO messages (id, project_id, topic_id, sender_id, body, reply_to, visibility, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'visible', ?)`
    ).bind(
      messageId, context.project_id, topicId, user.id, body || "(lampiran)",
      replyTo, createdAt
    ).run();
    try {
      for (const file of uploads) {
        const record = await uploadR2File(
          env, file, context.project_id, topicId, messageId, user,
          user.role === "vendor" ? "private" : "shared"
        );
        uploaded.push(record);
      }
    } catch (err) {
      for (const file of uploaded) {
        const row = await env.DB.prepare(`SELECT object_key FROM files WHERE id = ?`).bind(file.id).first();
        if (row?.object_key) await env.FILES.delete(row.object_key);
        await env.DB.prepare(`DELETE FROM files WHERE id = ?`).bind(file.id).run();
      }
      await env.DB.prepare(`DELETE FROM messages WHERE id = ?`).bind(messageId).run();
      throw err;
    }
    await audit(env, user.id, "message_send", messageId, context.project_id);
    await broadcast(env, topicId, { type: "message", messageId });
    const messages = await formatMessages(env, context, user);
    return json({ message: messages[messages.length - 1] || null }, 201);
  }

  const topicWsMatch = path.match(/^\/api\/topics\/([^/]+)\/ws$/);
  if (topicWsMatch && method === "GET") {
    const user = await requireUser(request, env);
    if (!user) return error("Unauthorized", 401);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("WebSocket upgrade required.", 426);
    const topicId = decodeURIComponent(topicWsMatch[1]);
    const context = await getTopicContext(env, topicId);
    if (!(await canReadContext(context, user))) return error("Project ditutup atau akses tidak tersedia.", 403);
    if (user.role === "vendor") await joinProject(env, context.project_id, user);
    const id = env.CHAT_ROOMS.idFromName(topicId);
    const stub = env.CHAT_ROOMS.get(id);
    const forwarded = new Request("https://chat-room.internal/connect", request);
    forwarded.headers.set("x-vdp-user-id", user.id);
    return stub.fetch(forwarded);
  }

  const moderateMatch = path.match(/^\/api\/messages\/([^/]+)\/moderate$/);
  if (moderateMatch && method === "POST") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat memoderasi pesan.", 403);
    const messageId = decodeURIComponent(moderateMatch[1]);
    const message = await env.DB.prepare(`SELECT id, topic_id, project_id FROM messages WHERE id = ?`).bind(messageId).first();
    if (!message) return error("Pesan tidak ditemukan.", 404);
    const body = await request.json().catch(() => ({}));
    if (!["visible", "hidden", "deleted"].includes(body.visibility)) return error("Status moderasi tidak valid.");
    const reason = String(body.reason || "").trim();
    if (body.visibility !== "visible" && reason.length < 5) return error("Alasan moderasi minimal 5 karakter.");
    await env.DB.prepare(
      `UPDATE messages SET visibility = ?, mod_reason = ?, mod_by = ?, mod_at = ? WHERE id = ?`
    ).bind(body.visibility, body.visibility === "visible" ? null : reason, user.id, now(), messageId).run();
    await audit(env, user.id, "message_moderate", messageId, message.project_id, reason || null);
    await broadcast(env, message.topic_id, { type: "moderation", messageId });
    return json({ ok: true });
  }

  if (path === "/api/admin/users" && method === "GET") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "admin") return error("Hanya Super Admin yang dapat mengelola pengguna.", 403);
    const result = await env.DB.prepare(
      `SELECT id, username, name, role, status, created_at, last_login
       FROM users WHERE role <> 'admin' ORDER BY created_at DESC`
    ).all();
    return json({ users: result.results || [] });
  }

  if (path === "/api/admin/users" && method === "POST") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "admin") return error("Hanya Super Admin yang dapat membuat akun Procurement.", 403);
    const body = await request.json().catch(() => ({}));
    const username = String(body.username || "").trim().toLowerCase();
    const name = String(body.name || "").trim();
    const password = String(body.password || "");
    if (!/^[a-z0-9._-]{3,30}$/.test(username)) return error("Username harus 3–30 karakter.");
    if (name.length < 3 || name.length > 120) return error("Nama harus 3–120 karakter.");
    if (password.length < 10) return error("Password minimal 10 karakter.");
    const salt = bytesToB64(crypto.getRandomValues(new Uint8Array(16)));
    const passHash = await passwordHash(password, salt);
    const id = makeId("u");
    try {
      await env.DB.prepare(
        `INSERT INTO users (id, username, name, password_hash, password_salt, role, status, created_at)
         VALUES (?, ?, ?, ?, ?, 'procurement', 'active', ?)`
      ).bind(id, username, name, passHash, salt, now()).run();
    } catch {
      return error("Username sudah digunakan.", 409);
    }
    await audit(env, user.id, "procurement_user_create", id);
    return json({ user: { id, username, name, role: "procurement", status: "active" } }, 201);
  }

  const adminUserStatus = path.match(/^\/api\/admin\/users\/([^/]+)\/status$/);
  if (adminUserStatus && method === "PATCH") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "admin") return error("Hanya Super Admin yang dapat mengubah status pengguna.", 403);
    const targetId = decodeURIComponent(adminUserStatus[1]);
    const target = await env.DB.prepare(`SELECT id, role FROM users WHERE id = ?`).bind(targetId).first();
    if (!target || target.role === "admin") return error("Pengguna tidak ditemukan atau tidak dapat diubah.", 404);
    const body = await request.json().catch(() => ({}));
    if (!["active", "inactive", "blocked"].includes(body.status)) return error("Status akun tidak valid.");
    await env.DB.prepare(`UPDATE users SET status = ? WHERE id = ?`).bind(body.status, targetId).run();
    if (body.status !== "active") {
      await env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?`).bind(targetId).run();
      await markSupportAgentOffline(env, targetId);
      await revokeUserConnections(env, targetId);
    }
    await audit(env, user.id, "user_status_change", targetId, null, String(body.reason || ""));
    return json({ ok: true, status: body.status });
  }

  if (path === "/api/live-chat/current" && method === "GET") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "vendor") return error("Live Chat hanya tersedia untuk akun Vendor.", 403);
    const conversation = await env.DB.prepare(
      "SELECT c.id, c.vendor_id, c.assigned_to, c.status, c.created_at, c.updated_at, c.last_message_at, c.first_agent_reply_at, c.closed_at, a.name AS assigned_name " +
      "FROM support_conversations c LEFT JOIN users a ON a.id = c.assigned_to " +
      "WHERE c.vendor_id = ? AND c.status IN ('waiting', 'active') ORDER BY c.updated_at DESC LIMIT 1"
    ).bind(user.id).first();
    return json({
      conversation: conversation || null,
      messages: conversation ? await getSupportMessages(env, conversation.id) : [],
      history: await supportHistory(env, user.id),
    });
  }

  if (path === "/api/live-chat/history" && method === "GET") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "vendor") return error("Live Chat hanya tersedia untuk akun Vendor.", 403);
    return json({ conversations: await supportHistory(env, user.id) });
  }

  if (path === "/api/live-chat/conversations" && method === "POST") {
    const user = await requireUser(request, env);
    if (!user || user.role !== "vendor") return error("Live Chat hanya tersedia untuk akun Vendor.", 403);
    const existing = await env.DB.prepare(
      "SELECT id FROM support_conversations WHERE vendor_id = ? AND status IN ('waiting', 'active') ORDER BY updated_at DESC LIMIT 1"
    ).bind(user.id).first();
    if (existing) {
      const conversation = await getSupportConversation(env, existing.id);
      return json({ conversation, messages: await getSupportMessages(env, existing.id) });
    }
    const agent = await env.DB.prepare(
      "SELECT u.id FROM users u JOIN support_agents a ON a.user_id = u.id " +
      "WHERE u.role IN ('procurement', 'admin') AND u.status = 'active' AND a.status = 'online' AND a.updated_at >= ? " +
      "ORDER BY (SELECT COUNT(*) FROM support_conversations c WHERE c.assigned_to = u.id AND c.status = 'active'), u.name LIMIT 1"
    ).bind(now() - 90000).first();
    const conversationId = makeId("sc");
    const createdAt = now();
    const status = agent ? "active" : "waiting";
    try {
      await env.DB.prepare(
        "INSERT INTO support_conversations (id, vendor_id, assigned_to, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(conversationId, user.id, agent?.id || null, status, createdAt, createdAt).run();
    } catch (err) {
      const raced = await env.DB.prepare(
        "SELECT id FROM support_conversations WHERE vendor_id = ? AND status IN ('waiting', 'active') ORDER BY updated_at DESC LIMIT 1"
      ).bind(user.id).first();
      if (!raced) throw err;
      const conversation = await getSupportConversation(env, raced.id);
      return json({ conversation, messages: await getSupportMessages(env, raced.id) });
    }
    await audit(env, user.id, "support_chat_open", conversationId);
    await supportBroadcast(env, "support_inbox", { type: "support_inbox_update", conversationId, status });
    const conversation = await getSupportConversation(env, conversationId);
    return json({ conversation, messages: [] }, 201);
  }

  const supportConversationMatch = path.match(/^\/api\/live-chat\/conversations\/([^/]+)$/);
  if (supportConversationMatch && method === "GET") {
    const user = await requireUser(request, env);
    if (!user) return error("Silakan login untuk membuka Live Chat.", 401);
    const conversationId = decodeURIComponent(supportConversationMatch[1]);
    const conversation = await getSupportConversation(env, conversationId);
    if (!conversation) return error("Percakapan Live Chat tidak ditemukan.", 404);
    if (!(isProcurement(user) || (user.role === "vendor" && conversation.vendor_id === user.id))) return error("Akses percakapan ditolak.", 403);
    return json({ conversation, messages: await getSupportMessages(env, conversationId) });
  }

  const supportMessagesMatch = path.match(/^\/api\/live-chat\/conversations\/([^/]+)\/messages$/);
  if (supportMessagesMatch && method === "POST") {
    const user = await requireUser(request, env);
    if (!user) return error("Silakan login untuk mengirim pesan.", 401);
    const conversationId = decodeURIComponent(supportMessagesMatch[1]);
    const conversation = await getSupportConversation(env, conversationId);
    if (!conversation) return error("Percakapan Live Chat tidak ditemukan.", 404);
    if (!(isProcurement(user) || (user.role === "vendor" && conversation.vendor_id === user.id))) return error("Akses percakapan ditolak.", 403);
    if (conversation.status === "closed") return error("Percakapan sudah ditutup.", 409);
    if (isProcurement(user) && conversation.assigned_to && conversation.assigned_to !== user.id && user.role !== "admin") {
      return error("Percakapan sedang ditangani agen lain. Minta transfer sebelum membalas.", 403);
    }
    if (isProcurement(user) && !conversation.assigned_to) {
      await env.DB.prepare(
        "UPDATE support_conversations SET assigned_to = ?, status = 'active', updated_at = ? WHERE id = ? AND assigned_to IS NULL"
      ).bind(user.id, now(), conversationId).run();
    }
    const body = await request.json().catch(() => ({}));
    const message = String(body.body || "").trim();
    if (!message) return error("Isi pesan wajib diisi.");
    if (message.length > MAX_MESSAGE) return error("Pesan maksimal " + MAX_MESSAGE + " karakter.");
    const senderRole = user.role === "vendor" ? "vendor" : "procurement";
    const messageId = makeId("sm");
    const createdAt = now();
    await env.DB.prepare(
      "INSERT INTO support_messages (id, conversation_id, sender_id, sender_role, body, created_at) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(messageId, conversationId, user.id, senderRole, message, createdAt).run();
    if (senderRole === "procurement") {
      await env.DB.prepare(
        "UPDATE support_conversations SET status = 'active', updated_at = ?, last_message_at = ?, first_agent_reply_at = COALESCE(first_agent_reply_at, ?) WHERE id = ?"
      ).bind(createdAt, createdAt, createdAt, conversationId).run();
    } else {
      await env.DB.prepare(
        "UPDATE support_conversations SET updated_at = ?, last_message_at = ? WHERE id = ?"
      ).bind(createdAt, createdAt, conversationId).run();
    }
    await audit(env, user.id, "support_chat_message", messageId);
    await supportBroadcast(env, "support:" + conversationId, { type: "support_message", messageId, senderRole });
    await supportBroadcast(env, "support_inbox", { type: "support_inbox_update", conversationId });
    return json({ message: { id: messageId, conversation_id: conversationId, sender_id: user.id, sender_role: senderRole, body: message, created_at: createdAt, sender_name: user.name } }, 201);
  }

  if (path === "/api/admin/live-chat/conversations" && method === "GET") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat melihat antrean Live Chat.", 403);
    await releaseStaleSupportAgents(env);
    await dispatchWaitingSupport(env);
    const wanted = url.searchParams.get("status") || "open";
    const valid = ["open", "waiting", "active", "closed", "all"];
    if (!valid.includes(wanted)) return error("Filter status tidak valid.");
    const statusFilter = wanted === "open" ? "c.status IN ('waiting', 'active')" :
      wanted === "all" ? "1 = 1" : "c.status = ?";
    const query = "SELECT c.id, c.vendor_id, c.assigned_to, c.status, c.created_at, c.updated_at, c.last_message_at, c.first_agent_reply_at, " +
      "v.name AS vendor_name, v.username AS vendor_username, a.name AS assigned_name, " +
      "(SELECT body FROM support_messages m WHERE m.conversation_id = c.id ORDER BY m.created_at DESC, m.id DESC LIMIT 1) AS last_message, " +
      "(SELECT COUNT(*) FROM support_messages m WHERE m.conversation_id = c.id) AS message_count " +
      "FROM support_conversations c JOIN users v ON v.id = c.vendor_id LEFT JOIN users a ON a.id = c.assigned_to " +
      "WHERE " + statusFilter + " ORDER BY CASE c.status WHEN 'waiting' THEN 0 WHEN 'active' THEN 1 ELSE 2 END, COALESCE(c.last_message_at, c.created_at) DESC";
    const result = wanted === "open" || wanted === "all"
      ? await env.DB.prepare(query).all()
      : await env.DB.prepare(query).bind(wanted).all();
    return json({ conversations: result.results || [] });
  }

  if (path === "/api/admin/live-chat/agents" && method === "GET") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat melihat agen Live Chat.", 403);
    const result = await env.DB.prepare(
      "SELECT u.id, u.name, u.username, u.role, COALESCE(a.status, 'offline') AS stored_status, " +
      "CASE WHEN a.updated_at >= ? THEN COALESCE(a.status, 'offline') ELSE 'offline' END AS status, " +
      "a.updated_at, (SELECT COUNT(*) FROM support_conversations c WHERE c.assigned_to = u.id AND c.status = 'active') AS active_count " +
      "FROM users u LEFT JOIN support_agents a ON a.user_id = u.id " +
      "WHERE u.role IN ('procurement', 'admin') AND u.status = 'active' ORDER BY u.name COLLATE NOCASE"
    ).bind(now() - 90000).all();
    return json({ agents: result.results || [] });
  }

  if (path === "/api/admin/live-chat/availability" && method === "PATCH") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat mengubah status agen.", 403);
    const body = await request.json().catch(() => ({}));
    const status = String(body.status || "");
    if (!["online", "busy", "offline"].includes(status)) return error("Status agen tidak valid.");
    const currentAgent = await env.DB.prepare(
      "SELECT status FROM support_agents WHERE user_id = ?"
    ).bind(user.id).first();
    const statusChanged = currentAgent?.status !== status;
    const updatedAt = now();
    await env.DB.prepare(
      "INSERT INTO support_agents (user_id, status, updated_at) VALUES (?, ?, ?) " +
      "ON CONFLICT(user_id) DO UPDATE SET status = excluded.status, updated_at = excluded.updated_at"
    ).bind(user.id, status, updatedAt).run();
    if (status === "offline") {
      const assigned = await env.DB.prepare(
        "SELECT id FROM support_conversations WHERE assigned_to = ? AND status = 'active'"
      ).bind(user.id).all();
      await env.DB.prepare(
        "UPDATE support_conversations SET assigned_to = NULL, status = 'waiting', updated_at = ? WHERE assigned_to = ? AND status = 'active'"
      ).bind(updatedAt, user.id).run();
      for (const row of assigned.results || []) {
        await supportBroadcast(env, "support:" + row.id, { type: "support_assignment", status: "waiting" });
      }
    }
    if (statusChanged) await audit(env, user.id, "support_agent_status", user.id, null, status);
    if (status === "online") {
      await releaseStaleSupportAgents(env);
      await dispatchWaitingSupport(env);
    }
    await supportBroadcast(env, "support_inbox", { type: "support_inbox_update", agentId: user.id, agentStatus: status });
    return json({ ok: true, status });
  }

  const supportClaimMatch = path.match(/^\/api\/admin\/live-chat\/conversations\/([^/]+)\/claim$/);
  if (supportClaimMatch && method === "POST") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat mengambil percakapan.", 403);
    const conversationId = decodeURIComponent(supportClaimMatch[1]);
    const conversation = await getSupportConversation(env, conversationId);
    if (!conversation || conversation.status === "closed") return error("Percakapan tidak tersedia.", 404);
    if (conversation.assigned_to && conversation.assigned_to !== user.id && user.role !== "admin") {
      return error("Percakapan sudah ditangani agen lain.", 409);
    }
    if (user.role !== "admin" && (await supportPresence(env, user.id)) === "offline") {
      return error("Ubah status Anda menjadi Online atau Sibuk sebelum mengambil chat.", 409);
    }
    await env.DB.prepare(
      "UPDATE support_conversations SET assigned_to = ?, status = 'active', updated_at = ? WHERE id = ?"
    ).bind(user.id, now(), conversationId).run();
    await audit(env, user.id, "support_chat_claim", conversationId);
    await supportBroadcast(env, "support:" + conversationId, { type: "support_assignment", status: "active", agentId: user.id });
    await supportBroadcast(env, "support_inbox", { type: "support_inbox_update", conversationId });
    return json({ conversation: await getSupportConversation(env, conversationId) });
  }

  const supportAssignMatch = path.match(/^\/api\/admin\/live-chat\/conversations\/([^/]+)\/assign$/);
  if (supportAssignMatch && method === "POST") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat mentransfer percakapan.", 403);
    const conversationId = decodeURIComponent(supportAssignMatch[1]);
    const conversation = await getSupportConversation(env, conversationId);
    if (!conversation || conversation.status === "closed") return error("Percakapan tidak tersedia.", 404);
    if (conversation.assigned_to && conversation.assigned_to !== user.id && user.role !== "admin") {
      return error("Hanya agen yang menangani atau Super Admin yang dapat mentransfer chat.", 403);
    }
    const body = await request.json().catch(() => ({}));
    const agentId = String(body.agentId || "");
    const target = await env.DB.prepare(
      "SELECT id, name, role, status FROM users WHERE id = ? AND role IN ('procurement', 'admin') AND status = 'active'"
    ).bind(agentId).first();
    if (!target) return error("Agen tujuan tidak ditemukan.", 404);
    if (await supportPresence(env, target.id) === "offline") return error("Agen tujuan harus Online atau Sibuk.");
    await env.DB.prepare(
      "UPDATE support_conversations SET assigned_to = ?, status = 'active', updated_at = ? WHERE id = ?"
    ).bind(target.id, now(), conversationId).run();
    await audit(env, user.id, "support_chat_transfer", conversationId, null, "Ditransfer ke " + target.name);
    await supportBroadcast(env, "support:" + conversationId, { type: "support_assignment", status: "active", agentId: target.id });
    await supportBroadcast(env, "support_inbox", { type: "support_inbox_update", conversationId });
    return json({ conversation: await getSupportConversation(env, conversationId) });
  }

  const supportCloseMatch = path.match(/^\/api\/admin\/live-chat\/conversations\/([^/]+)\/close$/);
  if (supportCloseMatch && method === "POST") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat menutup percakapan.", 403);
    const conversationId = decodeURIComponent(supportCloseMatch[1]);
    const conversation = await getSupportConversation(env, conversationId);
    if (!conversation || conversation.status === "closed") return error("Percakapan tidak tersedia atau sudah ditutup.", 404);
    if (conversation.assigned_to && conversation.assigned_to !== user.id && user.role !== "admin") {
      return error("Hanya agen yang menangani atau Super Admin yang dapat menutup chat.", 403);
    }
    await env.DB.prepare(
      "UPDATE support_conversations SET status = 'closed', closed_at = ?, updated_at = ? WHERE id = ?"
    ).bind(now(), now(), conversationId).run();
    await audit(env, user.id, "support_chat_close", conversationId);
    await supportBroadcast(env, "support:" + conversationId, { type: "support_closed" });
    await supportBroadcast(env, "support_inbox", { type: "support_inbox_update", conversationId });
    return json({ ok: true, status: "closed" });
  }

  const supportWsMatch = path.match(/^\/api\/live-chat\/conversations\/([^/]+)\/ws$/);
  if (supportWsMatch && method === "GET") {
    const user = await requireUser(request, env);
    if (!user) return error("Unauthorized", 401);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("WebSocket upgrade required.", 426);
    const conversationId = decodeURIComponent(supportWsMatch[1]);
    const conversation = await getSupportConversation(env, conversationId);
    if (!conversation || !(isProcurement(user) || (user.role === "vendor" && conversation.vendor_id === user.id))) {
      return error("Akses percakapan ditolak.", 403);
    }
    const stub = env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName("support:" + conversationId));
    const forwarded = new Request("https://chat-room.internal/connect", request);
    forwarded.headers.set("x-vdp-user-id", user.id);
    return stub.fetch(forwarded);
  }

  if (path === "/api/admin/live-chat/ws" && method === "GET") {
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat membuka koneksi antrean.", 403);
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return error("WebSocket upgrade required.", 426);
    const stub = env.CHAT_ROOMS.get(env.CHAT_ROOMS.idFromName("support_inbox"));
    const forwarded = new Request("https://chat-room.internal/connect", request);
    forwarded.headers.set("x-vdp-user-id", user.id);
    return stub.fetch(forwarded);
  }

  const fileMatch = path.match(/^\/api\/files\/([^/]+)$/);
  if (fileMatch && method === "GET") {
    const user = await requireUser(request, env);
    if (!user) return error("Silakan login untuk mengunduh file.", 401);
    return handleFileDownload(request, env, user, decodeURIComponent(fileMatch[1]));
  }

  const publishMatch = path.match(/^\/api\/files\/([^/]+)\/publish$/);
  if (publishMatch && method === "POST") {
    if (!env.FILES) return error("Penyimpanan lampiran belum diaktifkan.", 503);
    const user = await requireUser(request, env);
    if (!isProcurement(user)) return error("Hanya Procurement yang dapat mempublikasikan file sanitasi.", 403);
    const originalId = decodeURIComponent(publishMatch[1]);
    const original = await env.DB.prepare(
      `SELECT f.*, p.status AS project_status FROM files f JOIN projects p ON p.id = f.project_id WHERE f.id = ?`
    ).bind(originalId).first();
    if (!original || original.access !== "private") return error("File privat tidak ditemukan.", 404);
    const form = await request.formData();
    const sanitized = form.get("file");
    if (!sanitized || typeof sanitized !== "object" || !("size" in sanitized) || sanitized.size < 1) {
      return error("Pilih file sanitasi pengganti.");
    }
    if (sanitized.size > MAX_FILE_BYTES) return error("Ukuran file maksimal 2 MB.");
    if (!allowedUpload(sanitized)) return error("Format file sanitasi tidak diizinkan.");
    const record = await uploadR2File(
      env, sanitized, original.project_id, original.topic_id, original.message_id,
      user, "shared", original.id
    );
    await audit(env, user.id, "file_sanitized_publish", record.id, original.project_id);
    if (original.topic_id) await broadcast(env, original.topic_id, { type: "file_published", fileId: record.id });
    return json({ file: record }, 201);
  }

  return error("Endpoint tidak ditemukan.", 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      try {
        return await routeApi(request, env);
      } catch (err) {
        console.error("API error:", err);
        return error("Terjadi kesalahan server. Periksa Worker Logs untuk detail.", 500);
      }
    }
    return env.ASSETS.fetch(request);
  },
};

export class ChatRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/connect") {
      if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
        return new Response("Expected WebSocket", { status: 426 });
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment({
        userId: request.headers.get("x-vdp-user-id") || null,
        expiresAt: now() + SESSION_TTL,
      });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === "/broadcast" && request.method === "POST") {
      const payload = await request.text();
      let event = {};
      try { event = JSON.parse(payload); } catch {}
      for (const socket of this.ctx.getWebSockets()) {
        try {
          if (event.type === "revoke_user") {
            const attachment = socket.deserializeAttachment();
            if (attachment?.userId === event.userId) socket.close(1008, "Account disabled");
            continue;
          }
          socket.send(payload);
        } catch {
          try { socket.close(1011, "Broadcast failed"); } catch {}
        }
      }
      return new Response(null, { status: 204 });
    }

    return new Response("Not found", { status: 404 });
  }

  webSocketMessage(socket, message) {
    if (message === "authping") {
      try {
        const attachment = socket.deserializeAttachment();
        if (!attachment?.expiresAt || attachment.expiresAt < Date.now()) {
          socket.close(1008, "Session expired");
        } else {
          socket.send("pong");
        }
      } catch {
        try { socket.close(1011, "Session check failed"); } catch {}
      }
    }
  }

  webSocketClose(socket) {
    try { socket.close(); } catch {}
  }

  webSocketError(socket) {
    try { socket.close(1011, "WebSocket error"); } catch {}
  }
}
