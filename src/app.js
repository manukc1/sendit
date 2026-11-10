/* ==================================================================
   Телефон → Компьютер
   QR-код на компьютере, файловый менеджер на телефоне, передача
   по WebRTC DataChannel напрямую между устройствами.

   Сигнализация (только «рукопожатие» WebRTC) идёт через публичные
   MQTT-брокеры по WebSocket: ни один файл через них не передаётся.
   ================================================================== */
(function () {
  'use strict';

  /* ----------------------------- настройки ---------------------------- */
  var DEFAULTS = {
    maxFileSize: 25 * 1024 * 1024,
    chunkSize: 64 * 1024,
    highWaterMark: 4 * 1024 * 1024,
    brokers: [
      'wss://broker.emqx.io:8084/mqtt',
      'wss://broker.hivemq.com:8884/mqtt',
      'wss://test.mosquitto.org:8081/'
    ],
    iceServers: [
      { urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }
    ]
  };

  var CFG = Object.assign({}, DEFAULTS, window.P2F_CONFIG || {});
  var MAX = Number(CFG.maxFileSize) > 0 ? Number(CFG.maxFileSize) : DEFAULTS.maxFileSize;
  var CHUNK = Math.min(240 * 1024, Math.max(16 * 1024, Number(CFG.chunkSize) || 65536));
  var HIGH_WATER = Math.max(256 * 1024, Number(CFG.highWaterMark) || 4 * 1024 * 1024);
  var BROKERS = (CFG.brokers && CFG.brokers.length) ? CFG.brokers : DEFAULTS.brokers;

  var ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';
  var ROOM_KEY = 'p2f.room.v1';

  /* ------------------------------ утилиты ----------------------------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function now() { return (window.performance && performance.now) ? performance.now() : Date.now(); }

  var UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  function fmtSize(bytes) {
    var n = Number(bytes) || 0;
    if (n <= 0) return '0 Б';
    var i = 0;
    while (n >= 1024 && i < UNITS.length - 1) { n /= 1024; i++; }
    return (i === 0 ? Math.round(n) : n.toFixed(n < 10 ? 1 : 0)) + ' ' + UNITS[i];
  }
  function fmtSpeed(bps) { return bps > 0 ? fmtSize(bps) + '/с' : ''; }

  var SVG_HEAD = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">';
  var ICONS = {
    file: SVG_HEAD + '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/></svg>',
    image: SVG_HEAD + '<rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 18 4.5-4.5 4 4 3-3L20 18"/></svg>',
    video: SVG_HEAD + '<rect x="3" y="5" width="18" height="14" rx="2.5"/><path d="m10.5 9.2 4.6 2.8-4.6 2.8z"/></svg>',
    audio: SVG_HEAD + '<path d="M9 17V6.5l9-1.8V15"/><circle cx="6.5" cy="17.5" r="2.5"/><circle cx="15.5" cy="15.2" r="2.5"/></svg>',
    pdf: SVG_HEAD + '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 16.5c2.2-1.2 3.5-4.6 4-6.2.3-.9.8-1.1 1.1-.4.3.8-.8 2-2.4 2.9-1.7.9-3.2 1.1-3.7 1.9-.3.5 0 1.1.9 1.1 1.4 0 3.4-1 4.8-2.3"/></svg>',
    archive: SVG_HEAD + '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M12 4v5m0 3v2.5"/></svg>',
    sheet: SVG_HEAD + '<rect x="3.5" y="4" width="17" height="16" rx="2.5"/><path d="M3.5 10h17M9.5 4v16"/></svg>',
    code: SVG_HEAD + '<path d="m9 8.5-4 3.5 4 3.5M15 8.5l4 3.5-4 3.5"/></svg>',
    document: SVG_HEAD + '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/><path d="M8.5 12.5h7M8.5 16h5"/></svg>'
  };

  var ICON_RULES = [
    [/\.(jpe?g|png|gif|webp|heic|heif|bmp|tiff?|svg|avif|ico)$/i, 'image'],
    [/\.(mp4|m4v|mov|mkv|avi|webm|3gp|wmv|flv)$/i, 'video'],
    [/\.(mp3|wav|ogg|m4a|flac|aac|opus|wma)$/i, 'audio'],
    [/\.pdf$/i, 'pdf'],
    [/\.(zip|rar|7z|tar|gz|bz2|xz|iso)$/i, 'archive'],
    [/\.(xlsx?|csv|ods|numbers|tsv)$/i, 'sheet'],
    [/\.(docx?|rtf|odt|pages|pptx?|odp|key)$/i, 'document'],
    [/\.(txt|md|log|json|xml|ya?ml|html?|css|js|ts|jsx|tsx|py|go|rs|java|c|cc|cpp|cs|php|sh|ini|cfg|sql)$/i, 'code']
  ];
  function iconSvg(name) {
    for (var i = 0; i < ICON_RULES.length; i++) {
      if (ICON_RULES[i][0].test(name)) return ICONS[ICON_RULES[i][1]];
    }
    return ICONS.file;
  }

  function randomRoom() {
    var out = '';
    var buf = new Uint8Array(8);
    if (window.crypto && crypto.getRandomValues) crypto.getRandomValues(buf);
    else for (var i = 0; i < buf.length; i++) buf[i] = Math.floor(Math.random() * 256);
    for (var j = 0; j < buf.length; j++) out += ALPHABET.charAt(buf[j] & 31);
    return out;
  }

  function normalizeCode(v) { return String(v || '').toLowerCase().replace(/[^a-z0-9]/g, ''); }

  /* -------------------------------- DOM ------------------------------- */
  var el = {
    viewHost: $('#view-host'),
    viewSend: $('#view-send'),
    status: $('#status'),
    qrcode: $('#qrcode'),
    shareUrl: $('#share-url'),
    copyBtn: $('#copy-btn'),
    roomCode: $('#room-code'),
    newRoom: $('#new-room'),
    hostBanner: $('#host-banner'),
    hostBannerText: $('#host-banner-text'),
    fileWarning: $('#file-warning'),
    rxList: $('#rx-list'),
    rxEmpty: $('#rx-empty'),
    saveAll: $('#save-all'),
    goSend: $('#go-send'),
    goHost: $('#go-host'),
    sendTitle: $('#send-title'),
    sendHint: $('#send-hint'),
    codeForm: $('#code-form'),
    codeInput: $('#code-input'),
    retryBtn: $('#retry-btn'),
    picker: $('#picker'),
    fileInput: $('#file-input'),
    txWrap: $('#tx-list-wrap'),
    txList: $('#tx-list'),
    cancelBtn: $('#cancel-btn'),
    limitHost: $('#limit-host'),
    limitSend: $('#limit-send'),
    footLimit: $('#foot-limit'),
    tpl: $('#tpl-file')
  };

  /* ------------------------------- state ------------------------------ */
  var RTC = { pc: null, dc: null, pending: [], role: '' };

  var S = {
    room: '', mode: '',
    hostSignal: null, clientSignal: null,
    rx: null, rxRows: 0, hostRetries: 0,
    seq: 0, txRows: 0, busy: false, cancel: false, rejected: [],
    ready: false, helloTimer: 0, helloCount: 0, retries: 0, lastOffer: 0
  };

  var rowUid = 0;
  var wakeLock = null;

  /* ------------------------------ helpers ----------------------------- */
  function setStatus(text, kind) {
    el.status.textContent = text;
    el.status.dataset.state = kind || 'wait';
  }

  function showView(name) {
    el.viewHost.hidden = name !== 'host';
    el.viewSend.hidden = name !== 'send';
    S.mode = name;
  }

  function buildRow(name, size) {
    var li = el.tpl.content.firstElementChild.cloneNode(true);
    var row = {
      uid: ++rowUid,
      el: li,
      name: name,
      size: size,
      fill: li.querySelector('.bar > i'),
      stateEl: li.querySelector('.fstate'),
      action: li.querySelector('.fact'),
      blobUrl: ''
    };
    li.querySelector('.ficon').innerHTML = iconSvg(name);
    var nameEl = li.querySelector('.fname');
    nameEl.textContent = name;
    nameEl.title = name;
    li.querySelector('.fsize').textContent = fmtSize(size);
    row.stateEl.textContent = 'ожидание';
    row.fill.style.width = '0%';
    return row;
  }

  function flashButton(btn, text) {
    var old = btn.textContent;
    btn.textContent = text;
    btn.disabled = true;
    setTimeout(function () { btn.textContent = old; btn.disabled = false; }, 1400);
  }

  function saveRoom(room) { try { sessionStorage.setItem(ROOM_KEY, room); } catch (e) {} }
  function loadRoom() { try { return normalizeCode(sessionStorage.getItem(ROOM_KEY)); } catch (e) { return ''; } }

  function channelOpen() { return !!(RTC.dc && RTC.dc.readyState === 'open'); }

  async function requestWakeLock() {
    try {
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible') return;
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', function () { wakeLock = null; });
    } catch (e) { /* не критично */ }
  }
  function releaseWakeLock() {
    try { if (wakeLock) wakeLock.release(); } catch (e) {}
    wakeLock = null;
  }

  /* ==================================================================
     MQTT по WebSocket — минимальный клиент (QoS 0, только pub/sub)
     ================================================================== */
  var TE = new TextDecoder();
  var TEN = new TextEncoder();

  function mqttStr(str) {
    var b = TEN.encode(str);
    var out = new Uint8Array(b.length + 2);
    out[0] = (b.length >> 8) & 255;
    out[1] = b.length & 255;
    out.set(b, 2);
    return out;
  }

  function mqttPacket(header, parts) {
    var total = 0;
    for (var i = 0; i < parts.length; i++) total += parts[i].length;
    var rl = [];
    var n = total;
    do {
      var d = n % 128;
      n = Math.floor(n / 128);
      if (n > 0) d |= 128;
      rl.push(d);
    } while (n > 0);
    var out = new Uint8Array(1 + rl.length + total);
    out[0] = header;
    out.set(rl, 1);
    var off = 1 + rl.length;
    for (var j = 0; j < parts.length; j++) { out.set(parts[j], off); off += parts[j].length; }
    return out;
  }

  function SignalLink(url) {
    this.url = url;
    this.ws = null;
    this.buf = new Uint8Array(0);
    this.ready = false;
    this.dead = false;
    this.topics = [];
    this.queue = [];
    this.attempt = 0;
    this.pingTimer = null;
    this.retryTimer = null;
    this.dialTimer = null;
    this.onMessage = function () {};
    this.onState = function () {};
    this.clientId = 'p2f' + Math.random().toString(36).slice(2, 12);
    this.subId = 1;
  }

  SignalLink.prototype.start = function (topics, onMessage, onState) {
    this.topics = topics;
    this.onMessage = onMessage || function () {};
    this.onState = onState || function () {};
    this.dial();
  };

  SignalLink.prototype.dial = function () {
    var self = this;
    if (self.dead) return;
    self.onState('connecting', self.url);

    var ws;
    try { ws = new WebSocket(self.url, 'mqtt'); } catch (e) { self.scheduleRetry(); return; }

    ws.binaryType = 'arraybuffer';
    self.ws = ws;

    self.dialTimer = setTimeout(function () {
      if (self.ws === ws && !self.ready) {
        try { ws.close(); } catch (e) {}
        self.scheduleRetry();
      }
    }, 9000);

    ws.onopen = function () {
      if (self.dead) { try { ws.close(); } catch (e) {} return; }
      try { ws.send(mqttPacket(0x10, [mqttStr('MQTT'), new Uint8Array([4, 0x02, 0, 60]), mqttStr(self.clientId)])); }
      catch (e) { self.scheduleRetry(); }
    };

    ws.onmessage = function (ev) {
      if (self.ws === ws) self.ingest(ev.data);
    };

    ws.onclose = function () {
      if (self.dead || self.ws !== ws) return;
      clearTimeout(self.dialTimer);
      if (self.pingTimer) { clearInterval(self.pingTimer); self.pingTimer = null; }
      var wasReady = self.ready;
      self.ready = false;
      if (wasReady) self.onState('lost');
      self.scheduleRetry();
    };

    ws.onerror = function () { try { ws.close(); } catch (e) {} };
  };

  SignalLink.prototype.scheduleRetry = function () {
    var self = this;
    if (self.dead || self.retryTimer) return;
    self.attempt++;
    var delay = Math.min(9000, 1500 + self.attempt * 800) + Math.floor(Math.random() * 700);
    self.retryTimer = setTimeout(function () {
      self.retryTimer = null;
      self.dial();
    }, delay);
  };

  SignalLink.prototype.sendPacket = function (bytes) {
    if (this.ws && this.ws.readyState === 1) {
      try { this.ws.send(bytes); return true; } catch (e) { return false; }
    }
    return false;
  };

  SignalLink.prototype.publish = function (topic, text) {
    var pkt = mqttPacket(0x30, [mqttStr(topic), TEN.encode(text)]);
    if (this.ready && this.sendPacket(pkt)) return;
    if (this.queue.length < 40) this.queue.push(pkt);
  };

  SignalLink.prototype.flushQueue = function () {
    var q = this.queue;
    this.queue = [];
    for (var i = 0; i < q.length; i++) if (!this.sendPacket(q[i])) this.queue.push(q[i]);
  };

  SignalLink.prototype.subscribeAll = function () {
    for (var i = 0; i < this.topics.length; i++) {
      var pkt = mqttPacket(0x82, [
        new Uint8Array([(this.subId >> 8) & 255, this.subId & 255]),
        mqttStr(this.topics[i]),
        new Uint8Array([0])
      ]);
      this.subId = (this.subId % 65000) + 1;
      this.sendPacket(pkt);
    }
  };

  SignalLink.prototype.ingest = function (chunk) {
    var bytes = new Uint8Array(chunk);
    var buf = new Uint8Array(this.buf.length + bytes.length);
    buf.set(this.buf, 0);
    buf.set(bytes, this.buf.length);
    this.buf = buf;

    for (;;) {
      if (this.buf.length < 2) return;
      var len = 0, mult = 1, i = 1, complete = false;
      while (i < this.buf.length && i <= 4) {
        var b = this.buf[i++];
        len += (b & 127) * mult;
        mult *= 128;
        if (!(b & 128)) { complete = true; break; }
      }
      if (!complete) return;
      var total = i + len;
      if (this.buf.length < total) return;
      var header = this.buf[0];
      var body = this.buf.subarray(i, total);
      this.buf = this.buf.slice(total);
      this.packet(header, body);
    }
  };

  SignalLink.prototype.packet = function (header, body) {
    var type = header >> 4;

    if (type === 2) { // CONNACK
      if (this.ready) return;
      if (body.length >= 2 && body[1] !== 0) { // брокер отказал
        try { this.ws.close(); } catch (e) {}
        return;
      }
      this.ready = true;
      clearTimeout(this.dialTimer);
      this.subscribeAll();
      var self = this;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = setInterval(function () { self.sendPacket(new Uint8Array([0xc0, 0])); }, 40000);
      this.flushQueue();
      this.onState('ready');
      return;
    }

    if (type === 3) { // PUBLISH
      if (body.length < 3) return;
      var qos = (header >> 1) & 3;
      var tl = (body[0] << 8) | body[1];
      if (body.length < 2 + tl) return;
      var topic = TE.decode(body.subarray(2, 2 + tl));
      var off = 2 + tl;
      if (qos > 0) off += 2;
      var text = TE.decode(body.subarray(off));
      try { this.onMessage(topic, text); } catch (e) { console.warn('[signal]', e); }
    }
  };

  SignalLink.prototype.close = function () {
    this.dead = true;
    if (this.dialTimer) clearTimeout(this.dialTimer);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.dialTimer = this.retryTimer = this.pingTimer = null;
    this.queue = [];
    var ws = this.ws;
    this.ws = null;
    if (ws) { try { ws.close(); } catch (e) {} }
  };

  /* Шина: держим соединение со всеми брокерами сразу, чтобы две стороны
     гарантированно встретились, даже если им доступны разные серверы. */
  function SignalBus() {
    this.links = [];
    this.ready = false;
    this.onMessage = function () {};
    this.onState = function () {};
    this.seen = [];
    this.msgSeq = 0;
  }

  SignalBus.prototype.start = function (topics, onMessage, onState) {
    var self = this;
    this.onMessage = onMessage || function () {};
    this.onState = onState || function () {};
    this.onState('connecting');
    BROKERS.forEach(function (url) {
      var link = new SignalLink(url);
      self.links.push(link);
      link.start(topics, function (topic, text) { self.incoming(topic, text); }, function () { self.check(); });
    });
  };

  SignalBus.prototype.check = function () {
    var any = false;
    for (var i = 0; i < this.links.length; i++) {
      if (this.links[i].ready) { any = true; break; }
    }
    if (any && !this.ready) { this.ready = true; this.onState('ready'); }
    else if (!any && this.ready) { this.ready = false; this.onState('lost'); }
  };

  SignalBus.prototype.publish = function (topic, obj) {
    this.msgSeq++;
    obj.mid = Date.now().toString(36) + this.msgSeq.toString(36) + Math.random().toString(36).slice(2, 7);
    var text = JSON.stringify(obj);
    for (var i = 0; i < this.links.length; i++) this.links[i].publish(topic, text);
  };

  SignalBus.prototype.incoming = function (topic, text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }
    if (!msg || !msg.mid) return;
    if (this.seen.indexOf(msg.mid) !== -1) return;
    this.seen.push(msg.mid);
    if (this.seen.length > 80) this.seen.shift();
    this.onMessage(topic, text);
  };

  SignalBus.prototype.close = function () {
    for (var i = 0; i < this.links.length; i++) this.links[i].close();
    this.links = [];
    this.ready = false;
  };

  /* ------------------------------ топики ------------------------------ */
  function topicToHost(room) { return 'p2f/' + room + '/h'; }
  function topicToPhone(room) { return 'p2f/' + room + '/p'; }

  /* ==================================================================
     WebRTC: общая часть
     ================================================================== */
  function addRemoteCandidate(c) {
    if (!c || !RTC.pc) return;
    if (!RTC.pc.remoteDescription || !RTC.pc.remoteDescription.type) {
      RTC.pending.push(c);
      return;
    }
    RTC.pc.addIceCandidate(c).catch(function () {});
  }

  async function flushCandidates() {
    var list = RTC.pending;
    RTC.pending = [];
    for (var i = 0; i < list.length; i++) {
      try { await RTC.pc.addIceCandidate(list[i]); } catch (e) {}
    }
  }

  function closePc() {
    var pc = RTC.pc;
    RTC.pc = null;
    RTC.dc = null;
    RTC.pending = [];
    if (pc) { try { pc.close(); } catch (e) {} }
  }

  function attachChannel(dc) {
    RTC.dc = dc;
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = 256 * 1024;

    dc.onopen = function () {
      if (RTC.role === 'host') onHostChannelOpen();
      else onClientChannelOpen();
    };
    dc.onclose = function () {
      if (RTC.dc !== dc) return;
      RTC.dc = null;
      if (RTC.role === 'host') onHostChannelClosed();
      else onClientChannelClosed();
    };
    dc.onerror = function (e) { console.warn('[dc]', e); };
    dc.onmessage = function (ev) { onChannelData(ev.data); };
  }

  function onChannelData(data) {
    if (RTC.role === 'host') hostOnData(data);
    else clientOnData(data);
  }

  function onPcState() {
    if (!RTC.pc) return;
    var st = RTC.pc.connectionState;
    if (st === 'failed') {
      if (RTC.role === 'host') { hostResetPeer(); setStatus('Не удалось соединиться, ждём телефон', 'wait'); }
      else { clientRestart(); }
    }
  }

  /* ==================================================================
     РЕЖИМ КОМПЬЮТЕРА (приём)
     ================================================================== */
  function shareUrl(room) {
    if (location.protocol === 'file:') return '';
    return location.origin + location.pathname + '#r=' + room;
  }

  function renderQR(text) {
    if (!text || typeof qrcode !== 'function') { el.qrcode.innerHTML = ''; return; }
    try {
      var qr = qrcode(0, 'M');
      qr.addData(text, 'Byte');
      qr.make();
      el.qrcode.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
    } catch (err) {
      console.warn('QR render failed', err);
      el.qrcode.innerHTML = '';
    }
  }

  function setRoom(room) {
    S.room = room;
    saveRoom(room);
    el.roomCode.textContent = room;
    var url = shareUrl(room);
    if (url) {
      el.shareUrl.value = url;
      el.fileWarning.hidden = true;
      renderQR(url);
    } else {
      el.shareUrl.value = 'Откройте страницу по адресу https://…';
      el.fileWarning.hidden = false;
      renderQR('');
    }
  }

  function startHost(preferredRoom) {
    showView('host');
    stopClient();
    abortRx('Прервано');
    setConnected(false);

    var room = normalizeCode(preferredRoom);
    if (room.length < 4) room = loadRoom();
    if (room.length < 4) room = randomRoom();

    setRoom(room);
    hostListen(room);
  }

  function stopHost() {
    if (S.hostSignal) { S.hostSignal.close(); S.hostSignal = null; }
    closePc();
  }

  function stopClient() {
    if (S.clientSignal) { S.clientSignal.close(); S.clientSignal = null; }
    if (S.helloTimer) { clearInterval(S.helloTimer); S.helloTimer = 0; }
    closePc();
  }

  function setConnected(on) {
    document.body.classList.toggle('is-connected', !!on);
    el.hostBanner.hidden = !on;
    if (on) el.hostBannerText.textContent = 'Телефон подключён — выбирайте файлы.';
  }

  function hostListen(room) {
    stopHost();
    var sig = new SignalBus();
    S.hostSignal = sig;
    sig.start([topicToHost(room)], function (topic, text) {
      if (S.hostSignal === sig) hostOnSignal(text);
    }, function (state) {
      if (S.hostSignal !== sig) return;
      if (state === 'ready') setStatus(channelOpen() ? 'Телефон подключён' : 'Ждём телефон', channelOpen() ? 'ok' : 'wait');
      else if (state === 'connecting') setStatus('Подключение к серверу…', 'wait');
      else if (state === 'lost') setStatus('Сервер недоступен, повтор…', 'err');
    });
  }

  async function hostOnSignal(text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }

    if (msg.t === 'hello') {
      if (channelOpen()) return;
      await hostCreateOffer();
      return;
    }
    if (msg.t === 'answer' && RTC.pc) {
      try {
        await RTC.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        await flushCandidates();
      } catch (e) { console.warn('[host] answer', e); }
      return;
    }
    if (msg.t === 'ice') { addRemoteCandidate(msg.c); return; }
    if (msg.t === 'bye') { hostResetPeer(); }
  }

  function hostResetPeer() {
    abortRx('Соединение закрыто');
    closePc();
    setConnected(false);
    if (S.mode === 'host') setStatus('Ждём телефон', 'wait');
  }

  async function hostCreateOffer() {
    closePc();
    RTC.role = 'host';
    setStatus('Соединяемся…', 'wait');

    var pc;
    try {
      pc = new RTCPeerConnection({ iceServers: CFG.iceServers });
    } catch (e) {
      setStatus('Браузер не поддерживает WebRTC', 'err');
      return;
    }
    RTC.pc = pc;
    pc.onicecandidate = function (e) {
      if (e.candidate && S.hostSignal) {
        S.hostSignal.publish(topicToPhone(S.room), { t: 'ice', c: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = onPcState;

    var dc = pc.createDataChannel('p2f', { ordered: true });
    attachChannel(dc);

    try {
      var offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      S.hostSignal.publish(topicToPhone(S.room), { t: 'offer', sdp: pc.localDescription.sdp });
    } catch (e) {
      console.warn('[host] offer', e);
      setStatus('Ошибка соединения', 'err');
    }
  }

  function onHostChannelOpen() {
    setConnected(true);
    setStatus('Телефон подключён', 'ok');
  }

  function onHostChannelClosed() {
    setConnected(false);
    abortRx('Соединение прервано');
    if (S.mode === 'host') setStatus('Телефон отключился', 'wait');
  }

  function hostOnData(data) {
    if (typeof data === 'string') {
      var msg;
      try { msg = JSON.parse(data); } catch (e) { return; }
      if (!msg || typeof msg.t !== 'string') return;
      if (msg.t === 'meta') hostStartRx(msg);
      else if (msg.t === 'done') hostFinishRx(msg);
      else if (msg.t === 'abort') abortRx('Отменено на телефоне');
      return;
    }
    hostChunk(data);
  }

  function hostStartRx(meta) {
    abortRx('Прервано');
    var name = String(meta.name || 'файл').slice(0, 240);
    var size = Number(meta.size) || 0;
    var mime = typeof meta.mime === 'string' ? meta.mime : '';

    if (size > MAX) {
      if (RTC.dc && RTC.dc.readyState === 'open') {
        try { RTC.dc.send(JSON.stringify({ t: 'reject', id: meta.id })); } catch (e) {}
      }
      var bad = buildRow(name, size);
      el.rxList.appendChild(bad.el);
      bad.el.classList.add('is-error');
      bad.stateEl.textContent = 'больше лимита ' + fmtSize(MAX);
      afterRxRowAdded();
      return;
    }

    var row = buildRow(name, size);
    el.rxList.appendChild(row.el);
    afterRxRowAdded();

    S.rx = {
      id: meta.id,
      name: name,
      size: size,
      mime: mime,
      parts: [],
      received: 0,
      row: row,
      lastPaint: 0,
      speed: 0,
      sample: { t: now(), b: 0 }
    };
    paintRx(S.rx, true);
  }

  function afterRxRowAdded() {
    S.rxRows++;
    el.rxEmpty.hidden = true;
  }

  function hostChunk(data) {
    var rx = S.rx;
    if (!rx) return;
    var len = (data && data.byteLength !== undefined) ? data.byteLength : (data && data.size) || 0;
    if (!len) return;
    rx.parts.push(data);
    rx.received += len;
    if (rx.received > rx.size) { abortRx('Ошибка: лишние данные'); return; }
    paintRx(rx, false);
  }

  function paintRx(rx, force) {
    var t = now();
    if (!force && t - rx.lastPaint < 90) return;
    rx.lastPaint = t;

    var pct = rx.size ? Math.min(100, (rx.received / rx.size) * 100) : 0;
    rx.row.fill.style.width = pct.toFixed(1) + '%';

    var dt = (t - rx.sample.t) / 1000;
    if (dt > 0.45) {
      rx.speed = (rx.received - rx.sample.b) / dt;
      rx.sample = { t: t, b: rx.received };
    }
    rx.row.stateEl.textContent = Math.floor(pct) + '% · ' + fmtSize(rx.received) +
      (rx.speed > 0 ? ' · ' + fmtSpeed(rx.speed) : '');
  }

  function hostFinishRx() {
    var rx = S.rx;
    if (!rx) return;
    S.rx = null;

    if (rx.size && rx.received !== rx.size) {
      rx.row.el.classList.add('is-error');
      rx.row.stateEl.textContent = 'получено ' + fmtSize(rx.received) + ' из ' + fmtSize(rx.size);
      setStatus('Файл получен не полностью', 'err');
      return;
    }

    var blob = new Blob(rx.parts, { type: rx.mime || 'application/octet-stream' });
    rx.parts = [];
    rx.row.blobUrl = URL.createObjectURL(blob);
    rx.row.fill.style.width = '100%';
    rx.row.el.classList.add('is-done');
    rx.row.stateEl.textContent = 'готово';

    var a = document.createElement('a');
    a.className = 'btn';
    a.href = rx.row.blobUrl;
    a.download = rx.name;
    a.textContent = 'Скачать';
    rx.row.action.textContent = '';
    rx.row.action.appendChild(a);

    el.saveAll.hidden = false;
    setStatus('Файл получен', 'ok');
  }

  function abortRx(reason) {
    var rx = S.rx;
    if (!rx) return;
    S.rx = null;
    rx.row.el.classList.add('is-error');
    rx.row.stateEl.textContent = reason || 'прервано';
  }

  /* ==================================================================
     РЕЖИМ ТЕЛЕФОНА (отправка)
     ================================================================== */
  function startClient(room) {
    showView('send');
    stopHost();
    setConnected(false);
    S.room = normalizeCode(room);

    if (!S.room) {
      el.codeForm.hidden = false;
      el.picker.classList.add('is-disabled');
      el.retryBtn.hidden = true;
      el.sendTitle.textContent = 'Введите код комнаты';
      el.sendHint.textContent = 'Код показан на компьютере под QR-кодом.';
      setStatus('Нет подключения', 'wait');
      setTimeout(function () { try { el.codeInput.focus(); } catch (e) {} }, 80);
      return;
    }

    el.codeForm.hidden = true;
    el.codeInput.value = S.room;
    el.sendTitle.textContent = 'Подключение к компьютеру…';
    el.sendHint.textContent = 'Держите страницу с QR-кодом открытой на компьютере.';
    try { history.replaceState(null, '', '#r=' + S.room); } catch (e) {}
    clientListen(S.room);
  }

  function clientListen(room) {
    stopClient();
    S.ready = false;
    S.helloCount = 0;
    S.retries = 0;
    el.retryBtn.hidden = true;
    el.picker.classList.add('is-disabled');
    setStatus('Подключение…', 'wait');

    var sig = new SignalBus();
    S.clientSignal = sig;
    sig.start([topicToPhone(room)], function (topic, text) {
      if (S.clientSignal === sig) clientOnSignal(text);
    }, function (state) {
      if (S.clientSignal !== sig) return;
      if (state === 'ready') {
        clientBeginHello();
        setStatus(channelOpen() ? 'Подключено' : 'Ждём компьютер…', channelOpen() ? 'ok' : 'wait');
      } else if (state === 'connecting') {
        setStatus('Подключение к серверу…', 'wait');
      } else if (state === 'lost') {
        setStatus('Переподключение…', 'wait');
      }
    });
  }

  function clientBeginHello() {
    if (S.helloTimer) clearInterval(S.helloTimer);
    S.lastOffer = 0;
    clientSendHello();
    S.helloTimer = setInterval(clientSendHello, 4000);
  }

  function clientSendHello() {
    if (channelOpen() || !S.clientSignal || !S.clientSignal.ready) return;
    // если компьютер уже прислал offer, не мешаем идти рукопожатию
    if (S.lastOffer && Date.now() - S.lastOffer < 12000) return;
    S.helloCount++;
    if (S.helloCount > 6) {
      clearInterval(S.helloTimer);
      S.helloTimer = 0;
      failClient('Компьютер не в сети. Обновите QR-код на компьютере.');
      return;
    }
    S.clientSignal.publish(topicToHost(S.room), { t: 'hello' });
  }

  async function clientOnSignal(text) {
    var msg;
    try { msg = JSON.parse(text); } catch (e) { return; }

    if (msg.t === 'offer') {
      if (channelOpen()) return;
      S.lastOffer = Date.now();
      await clientAcceptOffer(msg.sdp);
      return;
    }
    if (msg.t === 'ice') { addRemoteCandidate(msg.c); }
  }

  async function clientAcceptOffer(sdp) {
    closePc();
    RTC.role = 'client';

    var pc;
    try {
      pc = new RTCPeerConnection({ iceServers: CFG.iceServers });
    } catch (e) {
      failClient('Браузер не поддерживает WebRTC');
      return;
    }
    RTC.pc = pc;
    pc.onicecandidate = function (e) {
      if (e.candidate && S.clientSignal) {
        S.clientSignal.publish(topicToHost(S.room), { t: 'ice', c: e.candidate.toJSON() });
      }
    };
    pc.onconnectionstatechange = onPcState;
    pc.ondatachannel = function (ev) { attachChannel(ev.channel); };

    try {
      await pc.setRemoteDescription({ type: 'offer', sdp: sdp });
      await flushCandidates();
      var answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      S.clientSignal.publish(topicToHost(S.room), { t: 'answer', sdp: pc.localDescription.sdp });
    } catch (e) {
      console.warn('[client] answer', e);
      failClient('Не удалось установить соединение.');
    }
  }

  function onClientChannelOpen() {
    S.ready = true;
    S.helloCount = 0;
    if (S.helloTimer) { clearInterval(S.helloTimer); S.helloTimer = 0; }
    setStatus('Подключено', 'ok');
    el.sendTitle.textContent = 'Выберите файлы';
    el.sendHint.textContent = 'Файлы уйдут на компьютер сразу после выбора. До ' + fmtSize(MAX) + ' на файл.';
    el.picker.classList.remove('is-disabled');
    el.retryBtn.hidden = true;
  }

  function onClientChannelClosed() {
    S.ready = false;
    el.picker.classList.add('is-disabled');
    if (S.busy) { failClient('Соединение прервано во время передачи.'); return; }
    if (S.mode !== 'send' || !S.room) return;
    setStatus('Восстанавливаем…', 'wait');
    setTimeout(function () {
      if (S.mode === 'send' && S.room) clientBeginHello();
    }, 1200);
  }

  function clientRestart() {
    closePc();
    S.ready = false;
    el.picker.classList.add('is-disabled');
    if (S.busy) { failClient('Соединение прервано во время передачи.'); return; }
    if (S.mode === 'send' && S.room) clientBeginHello();
  }

  function failClient(text) {
    setStatus(String(text).replace(/\.$/, ''), 'err');
    el.sendTitle.textContent = 'Не удалось подключиться';
    el.sendHint.textContent = text;
    el.retryBtn.hidden = false;
    el.picker.classList.add('is-disabled');
    if (S.helloTimer) { clearInterval(S.helloTimer); S.helloTimer = 0; }
    S.helloCount = 0;
  }

  function onClientData(data) {
    if (typeof data !== 'string') return;
    var msg;
    try { msg = JSON.parse(data); } catch (e) { return; }
    if (msg && msg.t === 'reject' && msg.id != null) S.rejected.push(msg.id);
  }

  /* --------------------------- отправка файлов ------------------------ */
  async function waitForBuffer(dc) {
    var guard = 0;
    while (dc.readyState === 'open' && dc.bufferedAmount > HIGH_WATER) {
      await sleep(10);
      if (++guard > 4000) throw new Error('buffer timeout');
    }
  }

  async function handleFiles(list) {
    if (!S.ready || !channelOpen()) {
      setStatus('Нет соединения с компьютером', 'err');
      return;
    }
    var files = Array.prototype.slice.call(list || []);
    if (!files.length) return;

    S.cancel = false;
    S.busy = true;
    el.cancelBtn.hidden = false;
    el.cancelBtn.disabled = false;
    el.txWrap.hidden = false;
    requestWakeLock();

    try {
      for (var i = 0; i < files.length; i++) {
        if (S.cancel) break;
        await sendOneFile(files[i]);
      }
    } finally {
      S.busy = false;
      el.cancelBtn.hidden = true;
      releaseWakeLock();
      setStatus(S.cancel ? 'Отменено' : 'Готово', S.cancel ? 'wait' : 'ok');
    }
  }

  async function sendOneFile(file) {
    if (!file) return;

    if (file.size > MAX) {
      var bad = buildRow(file.name, file.size);
      el.txList.appendChild(bad.el);
      bad.el.classList.add('is-error');
      bad.stateEl.textContent = 'больше лимита ' + fmtSize(MAX);
      return;
    }
    if (file.size === 0) {
      var empty = buildRow(file.name, 0);
      el.txList.appendChild(empty.el);
      empty.el.classList.add('is-error');
      empty.stateEl.textContent = 'пустой файл';
      return;
    }

    var id = ++S.seq;
    var row = buildRow(file.name, file.size);
    el.txList.appendChild(row.el);
    row.el.classList.add('is-receiving');

    var dc = RTC.dc;
    if (!dc || dc.readyState !== 'open') { row.el.classList.add('is-error'); row.stateEl.textContent = 'нет соединения'; return; }

    try {
      dc.send(JSON.stringify({ t: 'meta', id: id, name: file.name, size: file.size, mime: file.type || '' }));
    } catch (e) {
      row.el.classList.add('is-error');
      row.stateEl.textContent = 'не удалось начать';
      return;
    }

    var offset = 0;
    var chunks = 0;
    var lastPaint = 0;
    var sample = { t: now(), b: 0 };
    var speed = 0;

    try {
      while (offset < file.size) {
        if (S.cancel) {
          try { dc.send(JSON.stringify({ t: 'abort', id: id })); } catch (e) {}
          throw new Error('cancelled');
        }
        if (S.rejected.indexOf(id) !== -1) throw new Error('rejected');
        if (dc.readyState !== 'open') throw new Error('closed');

        await waitForBuffer(dc);

        var end = Math.min(offset + CHUNK, file.size);
        var buf = await file.slice(offset, end).arrayBuffer();
        dc.send(buf);
        offset = end;
        chunks++;

        var t = now();
        if (t - lastPaint > 90 || offset === file.size) {
          lastPaint = t;
          var dt = (t - sample.t) / 1000;
          if (dt > 0.45) {
            speed = (offset - sample.b) / dt;
            sample = { t: t, b: offset };
          }
          var pct = (offset / file.size) * 100;
          row.fill.style.width = pct.toFixed(1) + '%';
          row.stateEl.textContent = Math.floor(pct) + '% · ' + fmtSize(offset) + ' из ' + fmtSize(file.size) +
            (speed > 0 ? ' · ' + fmtSpeed(speed) : '');
        }

        if (chunks % 32 === 0) await sleep(0);
      }

      dc.send(JSON.stringify({ t: 'done', id: id }));
      row.fill.style.width = '100%';
      row.el.classList.remove('is-receiving');
      row.el.classList.add('is-done');
      row.stateEl.textContent = 'отправлено';
    } catch (err) {
      var reason = (err && err.message) || 'ошибка';
      row.el.classList.remove('is-receiving');
      row.el.classList.add('is-error');
      if (reason === 'cancelled') row.stateEl.textContent = 'отменено';
      else if (reason === 'rejected') row.stateEl.textContent = 'компьютер отклонил файл';
      else if (reason === 'closed') row.stateEl.textContent = 'соединение прервано';
      else row.stateEl.textContent = 'ошибка передачи';
    }
  }

  /* ============================== события ============================= */
  el.copyBtn.addEventListener('click', function () {
    var text = el.shareUrl.value;
    if (!text || location.protocol === 'file:') return;
    function done() { flashButton(el.copyBtn, 'Скопировано'); }
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(done, function () {
        el.shareUrl.select();
        try { document.execCommand('copy'); done(); } catch (e) {}
      });
    } else {
      el.shareUrl.select();
      try { document.execCommand('copy'); done(); } catch (e) {}
    }
  });

  el.newRoom.addEventListener('click', function () {
    if (S.busy) return;
    hostResetPeer();
    var room = randomRoom();
    setRoom(room);
    hostListen(room);
  });

  el.goSend.addEventListener('click', function (e) {
    e.preventDefault();
    startClient('');
  });

  el.goHost.addEventListener('click', function (e) {
    e.preventDefault();
    try { history.replaceState(null, '', location.pathname); } catch (err) {}
    startHost('');
  });

  el.retryBtn.addEventListener('click', function () {
    if (!S.room) { startClient(''); return; }
    clientListen(S.room);
  });

  el.cancelBtn.addEventListener('click', function () {
    S.cancel = true;
    el.cancelBtn.disabled = true;
  });

  el.saveAll.addEventListener('click', function () {
    var links = Array.prototype.slice.call(el.rxList.querySelectorAll('a[download]'));
    links.forEach(function (a, i) { setTimeout(function () { a.click(); }, i * 400); });
  });

  el.codeForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var room = normalizeCode(el.codeInput.value);
    if (room.length < 4) {
      el.sendHint.textContent = 'Код слишком короткий — проверьте его на компьютере.';
      el.codeInput.focus();
      return;
    }
    startClient(room);
  });

  el.fileInput.addEventListener('change', function (e) {
    var files = Array.prototype.slice.call(e.target.files || []);
    e.target.value = '';
    if (files.length) handleFiles(files);
  });

  ['dragenter', 'dragover'].forEach(function (type) {
    el.picker.addEventListener(type, function (e) {
      e.preventDefault();
      if (!el.picker.classList.contains('is-disabled')) el.picker.classList.add('is-over');
    });
  });
  ['dragleave', 'dragend'].forEach(function (type) {
    el.picker.addEventListener(type, function () { el.picker.classList.remove('is-over'); });
  });
  el.picker.addEventListener('drop', function (e) {
    e.preventDefault();
    el.picker.classList.remove('is-over');
    if (!S.ready) return;
    var files = e.dataTransfer && e.dataTransfer.files;
    if (files && files.length) handleFiles(files);
  });

  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible' && S.busy) requestWakeLock();
  });

  window.addEventListener('beforeunload', function (e) {
    if (S.busy) { e.preventDefault(); e.returnValue = ''; }
  });

  window.addEventListener('pagehide', function () {
    if (S.hostSignal) S.hostSignal.close();
    if (S.clientSignal) S.clientSignal.close();
    closePc();
  });

  /* ================================ старт ============================= */
  function boot() {
    el.limitHost.textContent = fmtSize(MAX);
    el.limitSend.textContent = fmtSize(MAX);
    el.footLimit.textContent = 'Лимит: ' + fmtSize(MAX) + ' на файл';

    if (location.protocol === 'file:') el.fileWarning.hidden = false;

    var hash = location.hash.replace(/^#/, '');
    var params = {};
    try { params = new URLSearchParams(hash); } catch (e) {}
    var room = normalizeCode(params.get ? params.get('r') : '');

    if (room.length >= 4) startClient(room);
    else startHost('');

    // отладочная ручка: window.__p2f в консоли браузера
    window.__p2f = { RTC: RTC, S: S, cfg: CFG };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
