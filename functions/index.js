const functions = require("firebase-functions");
const admin = require("firebase-admin");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");

admin.initializeApp({
  projectId: "sincere-nirvana-436014-v9",
  databaseURL: "https://nsmt-scorebug.firebaseio.com",
});
const db = admin.database();

// ── Constants ────────────────────────────────────────────────────
const SALT_ROUNDS = 10;
const OPERATOR_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours
const OWNER_SESSION_TTL_MS = 1 * 60 * 60 * 1000;    // 1 hour
const MAX_PIN_ATTEMPTS = 10;
const LOCKOUT_DURATION_MS = 15 * 60 * 1000;          // 15 minutes
const OPERATOR_PIN_LENGTH = 4;
const OWNER_PIN_MIN_LENGTH = 6;

// ── Rate Limiting ────────────────────────────────────────────────
// Keyed by eventId only (not IP) — school WiFi NATs all devices behind one IP,
// so IP-based keys would lock ALL devices when one person fails their PIN.
async function checkRateLimit(eventId) {
  const key = `rateLimits/${eventId}`;
  const ref = db.ref(key);
  const snap = await ref.once("value");
  const data = snap.val() || { attempts: 0, lockedUntil: 0 };

  if (data.lockedUntil > Date.now()) {
    const remainSec = Math.ceil((data.lockedUntil - Date.now()) / 1000);
    throw new functions.https.HttpsError(
      "resource-exhausted",
      `Too many attempts. Try again in ${remainSec}s.`
    );
  }

  if (data.attempts >= MAX_PIN_ATTEMPTS) {
    await ref.update({ lockedUntil: Date.now() + LOCKOUT_DURATION_MS });
    throw new functions.https.HttpsError(
      "resource-exhausted",
      "Too many attempts. Locked for 15 minutes."
    );
  }

  return { ref, attempts: data.attempts };
}

async function recordAttempt(rateRef, currentAttempts) {
  await rateRef.update({ attempts: currentAttempts + 1 });
}

async function clearAttempts(rateRef) {
  await rateRef.remove();
}

// ── Input Validation ─────────────────────────────────────────────
const EVENT_ID_REGEX = /^[a-zA-Z0-9_-]+$/;
function validateEventId(eventId) {
  if (!eventId || typeof eventId !== "string" || eventId.length < 2 || !EVENT_ID_REGEX.test(eventId)) {
    throw new functions.https.HttpsError("invalid-argument", "eventId must be 2+ chars: letters, numbers, hyphens, underscores only.");
  }
}

// ── Create Event ─────────────────────────────────────────────────
// Creates a new event with hashed operator and owner PINs
exports.createEvent = functions.https.onCall(async (data, context) => {
  const { eventId, eventTitle, operatorPin, ownerPin } = data;

  validateEventId(eventId);
  if (!operatorPin || operatorPin.length < OPERATOR_PIN_LENGTH) {
    throw new functions.https.HttpsError("invalid-argument", `Operator PIN must be at least ${OPERATOR_PIN_LENGTH} digits.`);
  }
  if (!ownerPin || ownerPin.length < OWNER_PIN_MIN_LENGTH) {
    throw new functions.https.HttpsError("invalid-argument", `Owner PIN must be at least ${OWNER_PIN_MIN_LENGTH} digits.`);
  }
  if (operatorPin === ownerPin) {
    throw new functions.https.HttpsError("invalid-argument", "Operator and owner PINs must be different.");
  }

  // Check if event already exists
  const existing = await db.ref(`adminEvents/${eventId}`).once("value");
  if (existing.exists()) {
    throw new functions.https.HttpsError("already-exists", "Event already exists.");
  }

  const operatorHash = await bcrypt.hash(operatorPin, SALT_ROUNDS);
  const ownerHash = await bcrypt.hash(ownerPin, SALT_ROUNDS);

  // Write admin event data (never publicly readable)
  await db.ref(`adminEvents/${eventId}`).set({
    eventTitle: eventTitle || eventId,
    operatorPinHash: operatorHash,
    ownerPinHash: ownerHash,
    createdAt: admin.database.ServerValue.TIMESTAMP,
    activeOperatorSessionId: null,
  });

  // Initialize public event data (readable by overlay)
  await db.ref(`publicEvents/${eventId}`).set({
    bug: {
      awayName: "AWAY",
      homeName: "HOME",
      awayCode: "",
      homeCode: "",
      awayScore: 0,
      homeScore: 0,
      clock: "8:00",
      clockRunning: false,
      quarter: "1ST",
      visible: true,
      eventTitle: eventTitle || "",
      bugScale: 1.25,
      bugLogoSize: 160,
      possession: "",
    },
    corners: {},
    ticker: { show: false, entries: [], speed: 50 },
    statsMode: false,
  });

  // Initialize game data nodes (flattened for performance)
  await db.ref(`gameData/${eventId}`).set({
    meta: {
      event: eventTitle || eventId,
      venue: "",
      date: "",
      time: "",
      periods: 4,
      periodLen: 8,
      keeper: "",
      status: "setup",
      seasonId: "",
      awayTeamId: "",
      homeTeamId: "",
      source: "nsmt_broadcast",
      finalized: false,
      finalizedAt: null,
    },
    rosters: {
      away: { name: "AWAY", code: "", teamCode: "", seasonYear: "", level: "" },
      home: { name: "HOME", code: "", teamCode: "", seasonYear: "", level: "" },
    },
    stats: {},
    onCourt: { away: {}, home: {} },
    periodScores: { away: {}, home: {} },
  });
  // gameEvents/{eventId} and gameSubLogs/{eventId} start empty — push-keyed

  // Audit log
  await db.ref(`auditLogs/${eventId}`).push({
    action: "EVENT_CREATED",
    timestamp: admin.database.ServerValue.TIMESTAMP,
    ip: context.rawRequest?.ip || "unknown",
  });

  return { success: true, eventId };
});

// ── Authenticate (PIN validation + session creation) ─────────────
exports.authenticate = functions.https.onCall(async (data, context) => {
  const { eventId, pin, role } = data;

  validateEventId(eventId);
  if (!pin || !role) {
    throw new functions.https.HttpsError("invalid-argument", "pin and role are required.");
  }
  if (role !== "operator" && role !== "owner") {
    throw new functions.https.HttpsError("invalid-argument", "Role must be 'operator' or 'owner'.");
  }

  const ip = context.rawRequest?.ip || "unknown";
  const { ref: rateRef, attempts } = await checkRateLimit(eventId);

  // Load admin event
  const adminSnap = await db.ref(`adminEvents/${eventId}`).once("value");
  if (!adminSnap.exists()) {
    await recordAttempt(rateRef, attempts);
    throw new functions.https.HttpsError("not-found", "Event not found.");
  }

  const adminData = adminSnap.val();
  const hashField = role === "owner" ? "ownerPinHash" : "operatorPinHash";
  const storedHash = adminData[hashField];

  if (!storedHash) {
    await recordAttempt(rateRef, attempts);
    throw new functions.https.HttpsError("failed-precondition", "PIN not configured for this role.");
  }

  const match = await bcrypt.compare(pin, storedHash);
  if (!match) {
    await recordAttempt(rateRef, attempts);
    throw new functions.https.HttpsError("permission-denied", "Invalid PIN.");
  }

  // PIN correct — clear rate limit and create session
  await clearAttempts(rateRef);

  const sessionId = uuidv4();
  const ttl = role === "owner" ? OWNER_SESSION_TTL_MS : OPERATOR_SESSION_TTL_MS;
  const expiresAt = Date.now() + ttl;

  // Create a custom Firebase Auth token so RTDB rules can check auth.uid
  const customToken = await admin.auth().createCustomToken(sessionId, {
    eventId,
    role,
    sessionId,
  });

  // Store session in RTDB (for rule validation)
  await db.ref(`sessions/${sessionId}`).set({
    eventId,
    role,
    createdAt: admin.database.ServerValue.TIMESTAMP,
    expiresAt,
    ip,
    revoked: false,
  });

  // If operator, claim the active operator lease atomically via transaction
  if (role === "operator") {
    let prevLease = null;
    const leaseRef = db.ref(`adminEvents/${eventId}/activeOperatorSessionId`);
    await leaseRef.transaction((currentLease) => {
      prevLease = currentLease;
      return sessionId;
    });

    // Revoke previous operator session if one existed
    if (prevLease && prevLease !== sessionId) {
      await db.ref(`sessions/${prevLease}/revoked`).set(true);
    }
  }

  // Audit log
  await db.ref(`auditLogs/${eventId}`).push({
    action: `${role.toUpperCase()}_AUTHENTICATED`,
    sessionId,
    timestamp: admin.database.ServerValue.TIMESTAMP,
    ip,
  });

  return {
    success: true,
    customToken,
    sessionId,
    role,
    eventId,
    expiresAt,
  };
});

// ── Renew Session ────────────────────────────────────────────────
exports.renewSession = functions.https.onCall(async (data, context) => {
  const { sessionId, eventId } = data;

  validateEventId(eventId);
  if (!sessionId) {
    throw new functions.https.HttpsError("invalid-argument", "sessionId required.");
  }

  // Verify caller is the session owner
  if (!context.auth || context.auth.uid !== sessionId) {
    throw new functions.https.HttpsError("unauthenticated", "Caller does not own this session.");
  }

  const sessionSnap = await db.ref(`sessions/${sessionId}`).once("value");
  if (!sessionSnap.exists()) {
    throw new functions.https.HttpsError("not-found", "Session not found.");
  }

  const session = sessionSnap.val();
  if (session.revoked) {
    throw new functions.https.HttpsError("permission-denied", "Session has been revoked.");
  }
  if (session.eventId !== eventId) {
    throw new functions.https.HttpsError("permission-denied", "Session/event mismatch.");
  }
  if (session.expiresAt < Date.now()) {
    throw new functions.https.HttpsError("permission-denied", "Session expired.");
  }

  const ttl = session.role === "owner" ? OWNER_SESSION_TTL_MS : OPERATOR_SESSION_TTL_MS;
  const newExpiry = Date.now() + ttl;

  await db.ref(`sessions/${sessionId}/expiresAt`).set(newExpiry);

  // Generate a fresh custom token
  const customToken = await admin.auth().createCustomToken(sessionId, {
    eventId: session.eventId,
    role: session.role,
    sessionId,
  });

  return { success: true, customToken, expiresAt: newExpiry };
});

// ── Revoke Session (owner action) ────────────────────────────────
exports.revokeOperator = functions.https.onCall(async (data, context) => {
  const { eventId, ownerSessionId } = data;

  validateEventId(eventId);
  if (!ownerSessionId) {
    throw new functions.https.HttpsError("invalid-argument", "ownerSessionId required.");
  }

  // Verify caller is an owner with valid session
  const ownerSnap = await db.ref(`sessions/${ownerSessionId}`).once("value");
  if (!ownerSnap.exists()) {
    throw new functions.https.HttpsError("not-found", "Owner session not found.");
  }
  const ownerSession = ownerSnap.val();
  if (ownerSession.role !== "owner" || ownerSession.eventId !== eventId || ownerSession.revoked || ownerSession.expiresAt < Date.now()) {
    throw new functions.https.HttpsError("permission-denied", "Invalid or expired owner session.");
  }

  // Find and revoke current operator
  const adminSnap = await db.ref(`adminEvents/${eventId}/activeOperatorSessionId`).once("value");
  const activeOpId = adminSnap.val();

  if (activeOpId) {
    await db.ref(`sessions/${activeOpId}/revoked`).set(true);
    await db.ref(`adminEvents/${eventId}/activeOperatorSessionId`).set(null);
  }

  // Audit
  await db.ref(`auditLogs/${eventId}`).push({
    action: "OPERATOR_REVOKED_BY_OWNER",
    revokedSessionId: activeOpId,
    ownerSessionId,
    timestamp: admin.database.ServerValue.TIMESTAMP,
  });

  return { success: true, revokedSessionId: activeOpId };
});

// ── Rotate PIN (owner action) ────────────────────────────────────
exports.rotatePin = functions.https.onCall(async (data, context) => {
  const { eventId, ownerSessionId, target, newPin } = data;

  validateEventId(eventId);
  if (!ownerSessionId || !target || !newPin) {
    throw new functions.https.HttpsError("invalid-argument", "ownerSessionId, target, and newPin required.");
  }
  if (target !== "operator" && target !== "owner") {
    throw new functions.https.HttpsError("invalid-argument", "Target must be 'operator' or 'owner'.");
  }

  const minLen = target === "owner" ? OWNER_PIN_MIN_LENGTH : OPERATOR_PIN_LENGTH;
  if (newPin.length < minLen) {
    throw new functions.https.HttpsError("invalid-argument", `PIN must be at least ${minLen} digits.`);
  }

  // Verify owner session
  const ownerSnap = await db.ref(`sessions/${ownerSessionId}`).once("value");
  if (!ownerSnap.exists()) {
    throw new functions.https.HttpsError("not-found", "Owner session not found.");
  }
  const ownerSession = ownerSnap.val();
  if (ownerSession.role !== "owner" || ownerSession.eventId !== eventId || ownerSession.revoked || ownerSession.expiresAt < Date.now()) {
    throw new functions.https.HttpsError("permission-denied", "Invalid owner session.");
  }

  const hash = await bcrypt.hash(newPin, SALT_ROUNDS);
  const field = target === "owner" ? "ownerPinHash" : "operatorPinHash";
  await db.ref(`adminEvents/${eventId}/${field}`).set(hash);

  // Audit
  await db.ref(`auditLogs/${eventId}`).push({
    action: `${target.toUpperCase()}_PIN_ROTATED`,
    ownerSessionId,
    timestamp: admin.database.ServerValue.TIMESTAMP,
  });

  return { success: true };
});

// ── Force Release Stats Mode (owner escape hatch) ───────────────
// Allows owner to clear statsMode lock when operator disconnects unexpectedly
exports.forceReleaseStats = functions.https.onCall(async (data, context) => {
  const { eventId, ownerSessionId } = data;

  validateEventId(eventId);
  if (!ownerSessionId) {
    throw new functions.https.HttpsError("invalid-argument", "ownerSessionId required.");
  }

  // Verify caller is an owner with valid session
  const ownerSnap = await db.ref(`sessions/${ownerSessionId}`).once("value");
  if (!ownerSnap.exists()) {
    throw new functions.https.HttpsError("not-found", "Owner session not found.");
  }
  const ownerSession = ownerSnap.val();
  if (ownerSession.role !== "owner" || ownerSession.eventId !== eventId || ownerSession.revoked || ownerSession.expiresAt < Date.now()) {
    throw new functions.https.HttpsError("permission-denied", "Invalid or expired owner session.");
  }

  // Clear statsMode and statsPresence
  await db.ref(`publicEvents/${eventId}`).update({
    statsMode: false,
    statsPresence: null,
  });

  // Audit
  await db.ref(`auditLogs/${eventId}`).push({
    action: "STATS_MODE_FORCE_RELEASED",
    ownerSessionId,
    timestamp: admin.database.ServerValue.TIMESTAMP,
  });

  return { success: true };
});

// ── Upload Asset URL (moves base64 out of RTDB) ─────────────────
// Client uploads to Cloud Storage, then calls this to record the URL
exports.registerAsset = functions.https.onCall(async (data, context) => {
  const { eventId, sessionId, assetType, assetKey, storageUrl } = data;

  validateEventId(eventId);
  if (!sessionId || !assetType || !storageUrl) {
    throw new functions.https.HttpsError("invalid-argument", "sessionId, assetType, and storageUrl required.");
  }

  // Verify session
  const sessionSnap = await db.ref(`sessions/${sessionId}`).once("value");
  if (!sessionSnap.exists()) {
    throw new functions.https.HttpsError("not-found", "Session not found.");
  }
  const session = sessionSnap.val();
  if (session.eventId !== eventId || session.revoked || session.expiresAt < Date.now()) {
    throw new functions.https.HttpsError("permission-denied", "Invalid session.");
  }

  // Validate storageUrl domain to prevent XSS via malicious URLs
  const ALLOWED_URL_PREFIXES = [
    "https://firebasestorage.googleapis.com/",
    "https://storage.googleapis.com/",
  ];
  if (!ALLOWED_URL_PREFIXES.some((p) => storageUrl.startsWith(p))) {
    throw new functions.https.HttpsError("invalid-argument", "Storage URL must be from Firebase Storage.");
  }

  // Validate assetKey against allowlist to prevent path injection via Admin SDK
  const ALLOWED_LOGO_KEYS = ["awayLogo", "homeLogo"];
  const ALLOWED_CORNER_KEYS = ["tl", "tr", "bl", "br"];

  if (assetType === "teamLogo") {
    if (!ALLOWED_LOGO_KEYS.includes(assetKey)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid logo key.");
    }
    await db.ref(`publicEvents/${eventId}/bug/${assetKey}`).set(storageUrl);
  } else if (assetType === "corner") {
    if (!ALLOWED_CORNER_KEYS.includes(assetKey)) {
      throw new functions.https.HttpsError("invalid-argument", "Invalid corner key.");
    }
    await db.ref(`publicEvents/${eventId}/corners/${assetKey}/src`).set(storageUrl);
  } else {
    throw new functions.https.HttpsError("invalid-argument", "Invalid asset type.");
  }

  return { success: true };
});
