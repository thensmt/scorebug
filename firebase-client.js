/**
 * NSMT Firebase Client — drop-in replacement for ws-client.js
 * Uses Firebase Realtime Database instead of WebSocket server.
 * No server required. Works from any device with internet.
 */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyD_ObMxqLz2LiuDiU4TWDT7G5FtWDeK_sI",
  authDomain: "sincere-nirvana-436014-v9.firebaseapp.com",
  databaseURL: "https://nsmt-scorebug.firebaseio.com",
  projectId: "sincere-nirvana-436014-v9",
  storageBucket: "sincere-nirvana-436014-v9.firebasestorage.app",
  appId: "1:417098775531:web:d1d88da74d217ecbd5f7ae"
};

const NSMTClient = (() => {
  let db = null;
  let stateRef = null;
  let _onMessage = null;
  let _onConnect = null;
  let _onDisconnect = null;
  let _connected = false;
  let _unsubscribe = null;

  const DEFAULT_STATE = {
    bug: {
      homeName: "", awayName: "",
      homeScore: 0, awayScore: 0,
      homeRecord: "", awayRecord: "",
      homeSeed: "", awaySeed: "",
      clock: "8:00", clockRunning: false, quarter: "1ST",
      shotClock: "", shotClockRunning: false,
      homeTOs: 5, awayTOs: 5,
      homeFouls: 0, awayFouls: 0,
      homeBonus: "", awayBonus: "",
      homeLogo: "", awayLogo: "",
      homePrimary: "#000000", homeSecondary: "#ffffff",
      homeText: "#ffffff",
      awayPrimary: "#0066cc", awaySecondary: "#ffffff",
      awayText: "#ffffff",
      possession: "", // "home" or "away"
      eventTitle: "", // top bar: "CHIPOTLE NATIONALS - QUARTERFINAL"
      visible: true
    },
    ticker: { entries: [], show: false, speed: 60 },
    stats: {
      meta: { eventTitle: "", gameDate: "", gameStatus: "" },
      away: { name: "", fouls: 0, players: [] },
      home: { name: "", fouls: 0, players: [] }
    }
  };

  async function connect() {
    if (db) return;

    // Firebase SDKs are loaded via script tags in HTML
    if (!window.firebase) {
      console.error("Firebase SDK not loaded. Add script tags first.");
      return;
    }

    if (!firebase.apps.length) {
      firebase.initializeApp(FIREBASE_CONFIG);
    }

    db = firebase.database();
    stateRef = db.ref("state");

    // Check if state exists, if not initialize it
    const snapshot = await stateRef.once("value");
    if (!snapshot.exists()) {
      await stateRef.set(DEFAULT_STATE);
    }

    // Listen for all state changes
    _unsubscribe = stateRef.on("value", (snap) => {
      const data = snap.val();
      if (data && _onMessage) {
        _onMessage({ type: "state", data });
      }
    });

    // Connection state monitoring
    const connRef = db.ref(".info/connected");
    connRef.on("value", (snap) => {
      _connected = snap.val() === true;
      if (_connected && _onConnect) _onConnect();
      if (!_connected && _onDisconnect) _onDisconnect();
    });
  }

  function disconnect() {
    if (_unsubscribe) {
      stateRef.off("value", _unsubscribe);
      _unsubscribe = null;
    }
    _connected = false;
  }

  function send(data) {
    if (!stateRef) return;

    if (data.type === "patch") {
      // Merge partial updates into specific sections
      const updates = {};
      for (const [key, value] of Object.entries(data)) {
        if (key === "type") continue;
        // If the key matches a top-level section, merge into it
        if (key === "bug" || key === "ticker" || key === "stats") {
          for (const [subKey, subVal] of Object.entries(value)) {
            updates[`${key}/${subKey}`] = subVal;
          }
        } else {
          // Assume it's a bug field for convenience
          updates[`bug/${key}`] = value;
        }
      }
      stateRef.update(updates);
    } else if (data.type === "set_state") {
      const section = data.section;
      if (section && data.data) {
        stateRef.child(section).set(data.data);
      }
    } else if (data.type === "increment") {
      stateRef.child(`bug/${data.key}`).transaction((current) => {
        return (current || 0) + data.delta;
      });
    }
  }

  // Convenience: patch bug fields directly
  function patchBug(fields) {
    send({ type: "patch", bug: fields });
  }

  return {
    connect,
    disconnect,
    send,
    patchBug,
    get connected() { return _connected; },
    onConnect(fn) { _onConnect = fn; },
    onDisconnect(fn) { _onDisconnect = fn; },
    onMessage(fn) { _onMessage = fn; },
    DEFAULT_STATE
  };
})();
