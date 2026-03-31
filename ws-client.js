/**
 * ws-client.js — Shared NSMT WebSocket helper
 * Include via: <script src="ws-client.js"></script>
 * Exposes a global `NSMTClient` object.
 *
 * Usage:
 *   NSMTClient.onConnect(() => { ... });
 *   NSMTClient.onDisconnect(() => { ... });
 *   NSMTClient.onMessage((msg) => { ... });
 *   NSMTClient.connect('ws://localhost:8765');
 *   NSMTClient.send({ type:'patch', bug:{ homeScore:42 } });
 */
(function (global) {
  'use strict';

  const DEFAULT_URL = (
    location.protocol === 'file:' || location.hostname === 'localhost'
      ? 'ws://localhost:8765'
      : 'ws://' + location.hostname + ':8765'
  );

  let _ws            = null;
  let _url           = DEFAULT_URL;
  let _connected     = false;
  let _reconnectTimer = null;
  let _intentionalClose = false;

  let _onMessage    = null;
  let _onConnect    = null;
  let _onDisconnect = null;

  function connect(url) {
    if (url) _url = url;
    _intentionalClose = false;
    clearTimeout(_reconnectTimer);

    try {
      _ws = new WebSocket(_url);

      _ws.onopen = function () {
        _connected = true;
        _ws.send(JSON.stringify({ type: 'get_state' }));
        if (_onConnect) _onConnect();
      };

      _ws.onmessage = function (evt) {
        try {
          const msg = JSON.parse(evt.data);
          if (_onMessage) _onMessage(msg);
        } catch (e) {}
      };

      _ws.onclose = function () {
        _connected = false;
        if (_onDisconnect) _onDisconnect();
        if (!_intentionalClose) {
          _reconnectTimer = setTimeout(function () { connect(); }, 2000);
        }
      };

      _ws.onerror = function () {
        _connected = false;
      };

    } catch (e) {
      _reconnectTimer = setTimeout(function () { connect(); }, 2000);
    }
  }

  function send(data) {
    if (_ws && _connected) {
      try { _ws.send(JSON.stringify(data)); } catch (e) {}
    }
  }

  function disconnect() {
    _intentionalClose = true;
    clearTimeout(_reconnectTimer);
    if (_ws) { try { _ws.close(); } catch (e) {} }
  }

  global.NSMTClient = {
    connect:      connect,
    send:         send,
    disconnect:   disconnect,
    onMessage:    function (fn) { _onMessage    = fn; },
    onConnect:    function (fn) { _onConnect    = fn; },
    onDisconnect: function (fn) { _onDisconnect = fn; },
    get connected() { return _connected; },
    get url()       { return _url; }
  };

})(window);
