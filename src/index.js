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
      iterations: 310000,
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
      if (session?.user_id) await revokeUserConnections(env, session.user_id);
    }
    return json({ ok: true }, 200, { "set-cookie": clearCookieHeader(new URL(request.url).protocol === "https:") });
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
    const id = makeId("p");
    await env.DB.prepare(
      `INSERT INTO projects (id, name, description, category, period, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`
    ).bind(id, name, description, category, period, user.id, now()).run();
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
      await revokeUserConnections(env, targetId);
    }
    await audit(env, user.id, "user_status_change", targetId, null, String(body.reason || ""));
    return json({ ok: true, status: body.status });
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
