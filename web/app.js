/* ============================================================
   萤石云监控墙 · 前端逻辑
   多画面播放 / 逐路错误状态 / 访问失败报告
   ============================================================ */
'use strict';

/* ------------------------------------------------------------
   0. 基础工具
   ------------------------------------------------------------ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
const LS_KEY = 'ezviz_wall_v2';

function nowStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function esc(str) {
  return String(str == null ? '' : str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast ' + kind; }, 3200);
}

async function api(path, body) {
  try {
    const res = await fetch(path, body ? {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    } : {});
    return await res.json();
  } catch (err) {
    return { ok: false, error: { code: 'NETERR', message: '本地服务不可达：' + err.message, stage: 'client' } };
  }
}

/* ------------------------------------------------------------
   1. 错误码知识库
   说明：错误码含义以萤石开放平台官方文档为准，此处为常用映射
   ------------------------------------------------------------ */
const CODEBOOK = {
  '10001': { label: '参数错误', cat: '请求参数', advice: '检查序列号、通道号、协议与清晰度参数是否合法。' },
  '10002': { label: 'accessToken 认证异常或已过期', cat: '凭证鉴权', advice: '在「设置凭证」中重新获取 Token，或核对 AppKey / AppSecret。' },
  '10005': { label: 'AppKey 异常', cat: '凭证鉴权', advice: '核对 AppKey 是否有效、是否被禁用或已删除。' },
  '10017': { label: '设备不在线', cat: '设备状态', advice: '检查设备供电与网络，确认设备在萤石云客户端的在线状态。' },
  '10030': { label: '设备不存在', cat: '设备与权限', advice: '核对设备序列号是否输入正确（注意 9 位字母数字）。' },
  '20001': { label: '参数错误', cat: '请求参数', advice: '检查序列号、通道号、协议与清晰度参数是否合法。' },
  '20002': { label: 'accessToken 过期或异常', cat: '凭证鉴权', advice: '重新获取 Token 后重试；确认系统时间准确。' },
  '20005': { label: 'AppKey 异常', cat: '凭证鉴权', advice: '核对 AppKey 归属与状态。' },
  '20007': { label: '设备不在线', cat: '设备状态', advice: '设备离线：检查供电、网线 / Wi-Fi、路由器是否正常，必要时重启设备。' },
  '20008': { label: '设备响应超时', cat: '设备状态', advice: '设备网络较差或处于休眠，稍后重试或检查上行带宽。' },
  '20010': { label: '设备序列号错误', cat: '设备与权限', advice: '核对序列号；确认该序列号属于当前应用对应账号。' },
  '20011': { label: '当前账号下无此设备', cat: '设备与权限', advice: '确认设备已添加到当前账号，且 AppKey 与账号匹配。' },
  '20014': { label: 'accessToken 异常', cat: '凭证鉴权', advice: '重新获取 Token，检查是否多个应用共用同一 Token。' },
  '20018': { label: '当前账号不拥有该设备', cat: '设备与权限', advice: '使用设备所属账号，或在开放平台完成设备授权 / 分享。' },
  '20032': { label: '设备不支持该操作', cat: '协议能力', advice: '该设备不支持所选协议或清晰度。尝试切换协议（HLS ↔ ezopen），或清晰度降为「流畅」。' },
  '49999': { label: '接口调用异常', cat: '服务端', advice: '萤石服务端异常，间隔一段时间重试；必要时提工单。' },
  '60000': { label: '直播未开始或已结束', cat: '协议能力', advice: '确认设备处于推流状态，或在客户端预览一次以唤醒设备。' },
  '60020': { label: '设备不支持该协议（常见于 HLS 未开通）', cat: '协议能力', advice: '改用 ezopen 协议；如需 HLS，联系萤石开通对应能力。' },
  'NO_CRED': { label: '未配置 AppKey / AppSecret', cat: '凭证鉴权', advice: '打开「添加监控 → 设置凭证」填写应用凭证并获取 Token。' },
  'NETERR': { label: '无法连接萤石开放平台', cat: '网络', advice: '检查本机网络、代理与防火墙，确认可访问 open.ys7.com。' },
  'HTTP_4XX': { label: '平台接口返回 HTTP 错误', cat: '网络', advice: '检查出网代理；若持续出现请联系平台支持。' },
  'TIMEOUT': { label: '已获取地址但未出画面', cat: '播放', advice: '码流未就绪或网络抖动，重试；仍失败可降低清晰度。' },
  'HLS_FATAL': { label: 'HLS 播放失败', cat: '播放', advice: '地址可能已过期或被 CDN 拒绝，重新获取地址后重试。' },
  'NO_PLUGIN': { label: 'hls.js 未加载', cat: '播放', advice: '播放内核缺失：请确认 web/vendor/hls.min.js 存在（离线部署必带），或本机可访问 CDN。' },
  'UNSUPPORTED': { label: '浏览器不支持该协议', cat: '协议能力', advice: 'RTMP 无法在浏览器直接播放，请改用 HLS 或 ezopen。' },
  'DEMO_FAIL': { label: '演示通道：模拟设备离线', cat: '演示', advice: '该通道为演示用，用于展示报告中的失败条目样式。' },
  'URL_EXPIRED': { label: '直播链接已过期', cat: '链接时效', advice: '链接中的 expire 参数已早于当前时间。请重新从萤石平台获取新的播放地址。' },
  'BAD_PARAM': { label: '参数不合法', cat: '请求参数', advice: '检查输入的序列号与通道号。' }
};

function lookupError(code) {
  const key = String(code || '').toUpperCase();
  if (CODEBOOK[key]) return CODEBOOK[key];
  if (/^HTTP_4/.test(key)) return CODEBOOK['HTTP_4XX'];
  return { label: '未知错误', cat: '其他', advice: '对照萤石开放平台错误码文档进一步定位，或联系平台技术支持。' };
}

/* ------------------------------------------------------------
   2. 状态与持久化
   ------------------------------------------------------------ */
const state = {
  layout: 4,
  cameras: [],       // 配置项
  cards: {},         // 运行时状态 id -> record
  settings: { protocol: 2, quality: 2 },
  lastReport: null,
  durationMs: 0,     // 最近一次「重新检测全部」的总耗时，供报告引用
  seq: 1
};

const PROTO_LABEL = { 1: 'ezopen', 2: 'HLS', 3: 'RTMP' };
const QUALITY_LABEL = { 1: '高清', 2: '流畅' };

function saveLocal() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      layout: state.layout,
      cameras: state.cameras,
      settings: state.settings,
      seq: state.seq
    }));
  } catch (e) { /* 忽略隐私模式下的写入失败 */ }
}

function loadLocal() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (Array.isArray(data.cameras)) state.cameras = data.cameras;
    if ([1, 4, 9, 16].includes(data.layout)) state.layout = data.layout;
    if (data.settings) Object.assign(state.settings, data.settings);
    if (data.seq) state.seq = data.seq;
  } catch (e) { /* 忽略损坏数据 */ }
}

/* ------------------------------------------------------------
   3. hls.js 动态加载（本地优先，CDN 兜底）
   ------------------------------------------------------------ */
let hlsLoader = null;
function ensureHls() {
  if (window.Hls && window.Hls.isSupported()) return Promise.resolve(true);
  if (hlsLoader) return hlsLoader;

  const loadScript = (src) => new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.async = true;
    s.onload = resolve;
    s.onerror = () => reject(new Error('load fail'));
    document.head.appendChild(s);
  });

  // 本地优先：内网 / 离线主机也能播放。CDN 仅作本地文件缺失时的兜底。
  const cdns = [
    'vendor/hls.min.js',
    'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.min.js',
    'https://unpkg.com/hls.js@1.5.17/dist/hls.min.js',
    'https://cdn.bootcdn.net/ajax/libs/hls.js/1.5.17/hls.min.js'
  ];

  hlsLoader = (async () => {
    for (const url of cdns) {
      try {
        await loadScript(url);
        if (window.Hls) return true;
      } catch (e) { /* 换下一个源 */ }
    }
    return false;
  })();
  return hlsLoader;
}

/* ------------------------------------------------------------
   4. 卡片 DOM
   ------------------------------------------------------------ */
const dom = {};   // id -> { card, video, stage, badge, foot, title, sub }

function buildCard(rec) {
  const el = document.createElement('div');
  el.className = 'card';
  el.dataset.card = rec.id;
  el.innerHTML = `
    <div class="card-head">
      <span class="badge info" data-badge>待播放</span>
      <span class="card-title" data-title title="${esc(rec.name)}">${esc(rec.name)}</span>
      <span class="card-sub">${esc(rec.directUrl ? 'DIRECT' : rec.serial + ':' + rec.channel)} · ${PROTO_LABEL[rec.protocol] || 'HLS'}</span>
      <div class="card-tools">
        <button class="mini" data-act="play">播放</button>
        <button class="mini" data-act="mute" title="切换声音">声音</button>
        <button class="mini" data-act="win" title="在独立窗口打开">独立窗</button>
        <button class="mini danger" data-act="del" title="移除该通道">移除</button>
      </div>
    </div>
    <div class="stage">
      <video playsinline muted autoplay></video>
      <div class="placeholder"><div class="hint">待播放</div></div>
    </div>
    <div class="card-foot">
      <span data-foot>—</span>
      <span class="grow"></span>
      <span data-err class=""></span>
    </div>`;

  const video = $('video', el);
  video.muted = true;

  el.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    if (act === 'play') playCamera(rec.id);
    else if (act === 'del') removeCamera(rec.id);
    else if (act === 'win') openWindow(rec);
    else if (act === 'mute') {
      video.muted = !video.muted;
      btn.textContent = video.muted ? '声音' : '静音';
      if (!video.muted) video.play().catch(() => {});
    }
  });

  dom[rec.id] = {
    card: el,
    video,
    stage: $('.stage', el),
    placeholder: $('.placeholder', el),
    badge: $('[data-badge]', el),
    foot: $('[data-foot]', el),
    errSlot: $('[data-err]', el)
  };
  return el;
}

const BADGE_TEXT = {
  idle: ['待播放', 'info'],
  connecting: ['取流中', 'warn'],
  buffering: ['缓冲中', 'warn'],
  playing: ['在线', 'ok'],
  error: ['失败', 'bad'],
  stopped: ['已停止', 'info']
};

function paintCard(id) {
  const rec = state.cards[id];
  const d = dom[id];
  if (!rec || !d) return;

  const [text, cls] = BADGE_TEXT[rec.status] || ['—', 'info'];
  d.badge.textContent = rec.status === 'error' && rec.error ? '失败 ' + rec.error.code : text;
  d.badge.className = 'badge ' + cls;
  d.card.className = 'card state-' + rec.status;

  // 占位 / 错误层
  $$('.errbox', d.stage).forEach(n => n.remove());
  if (rec.status === 'error' && rec.error) {
    const box = document.createElement('div');
    box.className = 'errbox';
    box.innerHTML = `
      <span class="code">${esc(rec.error.code)}</span>
      <div class="msg">${esc(rec.error.message || lookupError(rec.error.code).label)}</div>
      <div class="advice">${esc(rec.error.advice || lookupError(rec.error.code).advice)}</div>
      <button class="btn retry" data-act="retry">重新连接</button>`;
    box.querySelector('[data-act="retry"]').addEventListener('click', (e) => {
      e.stopPropagation();
      playCamera(id);
    });
    d.stage.appendChild(box);
    d.placeholder.style.display = 'none';
  } else if (rec.status === 'connecting' || rec.status === 'buffering') {
    d.placeholder.style.display = 'flex';
    const tip = rec.status === 'connecting'
      ? (rec.directUrl ? '正在连接直链…' : '正在获取直播地址…')
      : '正在缓冲码流…';
    d.placeholder.innerHTML = `<div class="spinner"></div><div class="hint">${tip}</div>`;
  } else if (rec.status === 'playing') {
    d.placeholder.style.display = 'none';
  } else {
    d.placeholder.style.display = 'flex';
    d.placeholder.innerHTML = `<div class="hint">${rec.status === 'stopped' ? '已停止播放' : '待播放'}</div>`;
  }

  // 底栏
  const parts = [];
  if (rec.latency) parts.push('取址 ' + rec.latency + ' ms');
  if (rec.expireAt && rec.status !== 'error') {
    parts.push((rec.directUrl ? '链接有效 ' : '地址有效 ') + expireText(rec.expireAt));
  }
  if (rec.attempts) parts.push('尝试 ' + rec.attempts + ' 次');
  if (!parts.length) parts.push('—');
  d.foot.textContent = parts.join(' · ');

  // 底栏右侧错误摘要
  if (rec.error) {
    d.errSlot.textContent = lookupError(rec.error.code).cat;
    d.errSlot.style.color = '#ef8f8f';
  } else {
    d.errSlot.textContent = '';
  }
}

function expireText(expireAt) {
  const left = Math.max(0, expireAt - Math.floor(Date.now() / 1000));
  if (left <= 0) return '已过期';
  const m = Math.floor(left / 60);
  if (m >= 1440) {
    const d = Math.floor(m / 1440);
    const h = Math.floor((m % 1440) / 60);
    return d + ' 天' + (h ? ' ' + h + ' 小时' : '');
  }
  if (m >= 60) return Math.floor(m / 60) + ' 小时 ' + (m % 60) + ' 分';
  if (m > 0) return m + ' 分 ' + (left % 60) + ' 秒';
  return left + ' 秒';
}

/* ------------------------------------------------------------
   5. 播放引擎
   ------------------------------------------------------------ */
function settle(rec) {
  if (rec.__resolve) {
    const fn = rec.__resolve;
    rec.__resolve = null;
    fn();
  }
  if (rec.__guard) {
    clearTimeout(rec.__guard);
    rec.__guard = null;
  }
}

function destroyPlayer(rec) {
  if (rec.hls) {
    try { rec.hls.destroy(); } catch (e) { /* ignore */ }
    rec.hls = null;
  }
  if (rec._raf) {
    cancelAnimationFrame(rec._raf);
    rec._raf = null;
  }
  const d = dom[rec.id];
  if (d) {
    d.video.onplaying = null;
    d.video.onerror = null;
    try { d.video.pause(); } catch (e) { /* ignore */ }
    d.video.removeAttribute('src');
    try { d.video.load(); } catch (e) { /* ignore */ }
    d.video.style.display = '';
    $$('canvas.demo', d.stage).forEach(n => n.remove());
  }
}

function setError(rec, code, message) {
  const info = lookupError(code);
  rec.status = 'error';
  rec.error = {
    code: String(code),
    message: message || info.label,
    advice: info.advice,
    category: info.cat,
    stage: 'play'
  };
  rec.lastTry = nowStr();
  destroyPlayer(rec);
  paintCard(rec.id);
  settle(rec);
}

function playCamera(id, opts = {}) {
  return new Promise((resolve) => {
    const rec = state.cards[id];
    if (!rec) return resolve();

    destroyPlayer(rec);
    settle(rec);
    rec.__resolve = resolve;
    // 每次发起都递增序号：异步响应回来时若已不是最新一次则丢弃，
    // 避免快速连点或"停止后立刻重连"时旧响应覆盖新状态
    const mySeq = rec.__seq = (rec.__seq || 0) + 1;
    rec.__guard = setTimeout(() => {
      if (rec.__seq !== mySeq) return;
      if (rec.status === 'connecting' || rec.status === 'buffering') {
        setError(rec, 'TIMEOUT', '等待超时：' + (rec.status === 'connecting' ? '未取得直播地址' : '未收到码流'));
      } else {
        settle(rec);
      }
    }, 32000);

    if (!opts.soft) {
      rec.attempts = (rec.attempts || 0) + 1;
      rec.recover = 0;   // 手动重连时重置网络自恢复配额，否则重连后第二次网络错误就直接判失败
    }
    rec.status = 'connecting';
    rec.error = null;
    rec.lastTry = nowStr();
    paintCard(id);

    // 1) 演示通道
    if (rec.demo === 'fail') {
      setTimeout(() => {
        if (rec.__seq === mySeq) setError(rec, 'DEMO_FAIL', '演示通道：模拟设备离线');
      }, 700);
      return;
    }
    if (rec.demo === 'stream') {
      startDemoStream(rec);
      return;
    }

    // 2) 直接链接
    if (rec.directUrl) {
      // 链接自带 expire 参数且已过期时直接判失败，不必徒劳请求
      if (rec.expireAt && rec.expireAt < Math.floor(Date.now() / 1000)) {
        setError(rec, 'URL_EXPIRED',
          '链接已于 ' + new Date(rec.expireAt * 1000).toLocaleString() + ' 过期');
        return;
      }
      rec.status = 'buffering';
      paintCard(id);
      startPlayback(rec, rec.directUrl, rec.protocol);
      return;
    }

    // 3) 走开放平台接口
    fetch('/api/live', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        serial: rec.serial,
        channel: rec.channel,
        protocol: rec.protocol,
        quality: rec.quality
      })
    }).then(r => r.json()).then((res) => {
      if (rec.__seq !== mySeq || rec.status === 'stopped') return;
      if (!res.ok) {
        const err = res.error || { code: 'UNEXPECTED', message: '接口未返回有效结果' };
        setError(rec, err.code, err.message);
        return;
      }
      rec.latency = res.data.__latency || rec.latency;
      rec.expireAt = res.data.expireAt || 0;
      rec.status = 'buffering';
      paintCard(id);
      startPlayback(rec, res.data.url, rec.protocol);
    }).catch((err) => {
      if (rec.__seq !== mySeq) return;
      setError(rec, 'NETERR', '本地服务调用失败：' + err.message);
    });
  });
}

function startPlayback(rec, url, protocol) {
  if (protocol === 1) {
    // ezopen：浏览器需借助 EzUIKit，此处给出明确说明而非静默失败
    setError(rec, 'UNSUPPORTED', '本工具未启用 ezopen 播放内核，请改用 HLS 协议（protocol=2）');
    return;
  }
  if (protocol === 3 || /^rtmp:\/\//i.test(url)) {
    setError(rec, 'UNSUPPORTED', 'RTMP 协议无法在浏览器直接播放，请改用 HLS');
    return;
  }
  if (/\.flv(\?|$)/i.test(url)) {
    setError(rec, 'UNSUPPORTED', '该地址为 FLV 流，浏览器需额外播放内核，请改用 m3u8 地址');
    return;
  }
  startHls(rec, url);
}

async function startHls(rec, url) {
  const d = dom[rec.id];
  if (!d) return;
  const mySeq = rec.__seq;   // 本轮发起的序号，await 之后用它校验是否已过期
  const video = d.video;

  video.onplaying = () => {
    if (rec.status === 'stopped') return;
    rec.status = 'playing';
    rec.error = null;
    rec.lastOk = nowStr();
    paintCard(rec.id);
    settle(rec);
  };

  video.onerror = () => {
    if (rec.status === 'stopped' || rec.status === 'error') return;
    setError(rec, 'HLS_FATAL', 'video 元素解码失败，地址可能已失效');
  };

  // 优先 hls.js：错误事件可控、可归类；原生 HLS 仅在内核不可用时兜底。
  // 注意：Chrome 对 canPlayType 返回 "maybe" 但并不真正支持 HLS，
  // 若先走原生分支会静默黑屏且拿不到错误，因此顺序不能反。
  const ok = await ensureHls();
  // await 期间通道可能已被移除、停止或重新发起，此时不得再创建播放实例，
  // 否则会产生被覆盖的 hls 实例（泄漏）或把画面绑到已移除的元素上
  if (rec.__seq !== mySeq || !state.cards[rec.id] || rec.status === 'stopped') return;
  if (!ok) {
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = url;
      video.play().catch(() => { /* 自动播放受限，等待用户交互 */ });
      return;
    }
    setError(rec, 'NO_PLUGIN', 'hls.js 加载失败（本地 vendor 缺失且 CDN 不可达）');
    return;
  }

  const hls = new window.Hls({
    lowLatencyMode: false,
    enableWorker: true,
    manifestLoadingTimeOut: 12000,
    manifestLoadingMaxRetry: 2,
    levelLoadingTimeOut: 12000,
    fragLoadingTimeOut: 25000,
    fragLoadingMaxRetry: 3
  });
  rec.hls = hls;

  hls.on(window.Hls.Events.ERROR, (_evt, data) => {
    if (!data || !data.fatal) return;
    if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
      if ((rec.recover || 0) < 1) {
        rec.recover = (rec.recover || 0) + 1;
        try { hls.startLoad(); return; } catch (e) { /* fallthrough */ }
      }
      setError(rec, 'HLS_FATAL', '网络错误（' + (data.details || 'manifest/frag 加载失败') + '）');
    } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
      try { hls.recoverMediaError(); } catch (e) {
        setError(rec, 'HLS_FATAL', '媒体解码错误：' + (data.details || ''));
      }
    } else {
      setError(rec, 'HLS_FATAL', data.details || 'HLS 播放失败');
    }
  });

  hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
    video.play().catch(() => { /* 静音状态下通常可自动播放 */ });
  });

  hls.loadSource(url);
  hls.attachMedia(video);
}

/* ---- 演示通道：本地测试图 ---- */
function startDemoStream(rec) {
  const d = dom[rec.id];
  if (!d) return;
  const canvas = document.createElement('canvas');
  canvas.className = 'demo';
  canvas.style.position = 'absolute';
  canvas.style.inset = '0';
  canvas.style.width = '100%';
  canvas.style.height = '100%';
  d.stage.appendChild(canvas);
  d.video.style.display = 'none';

  const ctx = canvas.getContext('2d');
  const t0 = performance.now();

  const draw = () => {
    const w = canvas.width = canvas.clientWidth || 640;
    const h = canvas.height = canvas.clientHeight || 360;
    const t = (performance.now() - t0) / 1000;

    ctx.fillStyle = '#06090d';
    ctx.fillRect(0, 0, w, h);

    // 网格
    ctx.strokeStyle = '#12202b';
    ctx.lineWidth = 1;
    for (let x = 0; x < w; x += 40) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, h); ctx.stroke(); }
    for (let y = 0; y < h; y += 40) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(w, y); ctx.stroke(); }

    // 扫描线
    const y = (t * 60) % h;
    const grad = ctx.createLinearGradient(0, y - 26, 0, y + 26);
    grad.addColorStop(0, 'rgba(34,211,238,0)');
    grad.addColorStop(.5, 'rgba(34,211,238,.22)');
    grad.addColorStop(1, 'rgba(34,211,238,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, y - 26, w, 52);

    // 十字准星
    ctx.strokeStyle = 'rgba(34,211,238,.35)';
    ctx.beginPath(); ctx.moveTo(w / 2, h / 2 - 18); ctx.lineTo(w / 2, h / 2 + 18); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(w / 2 - 18, h / 2); ctx.lineTo(w / 2 + 18, h / 2); ctx.stroke();

    // 文字
    ctx.fillStyle = '#7dd3e8';
    ctx.font = '600 13px "Microsoft YaHei", sans-serif';
    ctx.fillText(rec.name, 14, 24);

    ctx.fillStyle = '#3f5a6d';
    ctx.font = '12px ui-monospace, Consolas, monospace';
    ctx.fillText('DEMO SOURCE · NO REAL STREAM', 14, h - 30);
    ctx.fillText(nowStr() + ' · ' + t.toFixed(1) + 's', 14, h - 12);

    rec._raf = requestAnimationFrame(draw);
  };
  draw();

  rec.status = 'playing';
  rec.latency = 0;
  rec.error = null;
  rec.lastOk = nowStr();
  paintCard(rec.id);
  settle(rec);
}

function stopCamera(id) {
  const rec = state.cards[id];
  if (!rec) return;
  rec.status = 'stopped';
  destroyPlayer(rec);
  const d = dom[id];
  if (d) d.video.style.display = '';
  paintCard(id);
  settle(rec);
}

/* ------------------------------------------------------------
   6. 增删通道
   ------------------------------------------------------------ */
function addCameras(list, autoPlay) {
  const added = [];
  for (const item of list) {
    const rec = {
      id: 'c' + (state.seq++),
      name: item.name || item.serial || '未命名通道',
      serial: item.serial || '',
      channel: item.channel || 1,
      protocol: item.protocol || state.settings.protocol,
      quality: item.quality || state.settings.quality,
      directUrl: item.directUrl || '',
      demo: item.demo || '',
      // 运行时
      status: 'idle',
      error: null,
      attempts: 0,
      latency: 0,
      expireAt: item.expireAt || 0,
      lastTry: '',
      lastOk: ''
    };
    state.cameras.push({
      id: rec.id, name: rec.name, serial: rec.serial, channel: rec.channel,
      protocol: rec.protocol, quality: rec.quality, directUrl: rec.directUrl,
      demo: rec.demo, expireAt: rec.expireAt
    });
    state.cards[rec.id] = rec;
    const el = buildCard(rec);
    $('#grid').appendChild(el);
    added.push(rec);
  }
  saveLocal();
  refreshEmpty();
  if (autoPlay) added.forEach(rec => playCamera(rec.id));
  return added;
}

function removeCamera(id) {
  const rec = state.cards[id];
  if (!rec) return;
  destroyPlayer(rec);
  settle(rec);
  const d = dom[id];
  if (d && d.card.parentNode) d.card.parentNode.removeChild(d.card);
  delete dom[id];
  delete state.cards[id];
  state.cameras = state.cameras.filter(c => c.id !== id);
  saveLocal();
  refreshEmpty();
}

function refreshEmpty() {
  const has = Object.keys(state.cards).length > 0;
  $('#empty').classList.toggle('hide', has);
}

function openWindow(rec) {
  const params = new URLSearchParams({
    name: rec.name,
    serial: rec.serial,
    channel: String(rec.channel),
    protocol: String(rec.protocol),
    quality: String(rec.quality),
    url: rec.directUrl || '',
    demo: rec.demo || ''
  });
  window.open('player.html?' + params.toString(), '_blank',
    'width=880,height=560,menubar=no,toolbar=no');
}

function loadDemoCameras(autoPlay) {
  return addCameras([
    { name: '演示通道 A · 本地测试图', demo: 'stream', serial: 'DEMO-STREAM-A', channel: 1, protocol: 2, quality: 2 },
    { name: '演示通道 B · 本地测试图', demo: 'stream', serial: 'DEMO-STREAM-B', channel: 1, protocol: 2, quality: 2 },
    { name: '演示通道 C · 模拟设备离线', demo: 'fail', serial: 'DEMO-OFFLINE', channel: 1, protocol: 2, quality: 2 }
  ], autoPlay);
}

/* ------------------------------------------------------------
   7. 报告
   ------------------------------------------------------------ */
function buildReport() {
  const all = Object.values(state.cards);
  // 演示通道仍参与统计（否则无法用它验证报告样式），但单独计数并在结论中
  // 明确标注，避免把本地测试图误读为真实设备的可达性
  const recs = all;
  const demoAll = all.filter(r => r.demo);
  const ok = recs.filter(r => r.status === 'playing');
  const fail = recs.filter(r => r.status === 'error');
  const pending = recs.filter(r => r.status === 'idle' || r.status === 'stopped');
  const checking = recs.filter(r => r.status === 'connecting' || r.status === 'buffering');
  const evaluated = ok.length + fail.length;
  const rate = evaluated ? Math.round((ok.length / evaluated) * 1000) / 10 : 0;

  const failures = fail.map(r => {
    const info = lookupError(r.error.code);
    return {
      name: r.name,
      serial: r.serial || (r.directUrl ? '(直接链接)' : '-'),
      channel: r.channel,
      protocol: PROTO_LABEL[r.protocol] || 'HLS',
      code: r.error.code,
      message: r.error.message || info.label,
      stage: r.error.stage || 'api',
      category: r.error.category || info.cat,
      advice: r.error.advice || info.advice,
      attempts: r.attempts || 1,
      lastTry: r.lastTry || nowStr()
    };
  });

  // 归类聚合
  const catMap = new Map();
  failures.forEach(f => {
    if (!catMap.has(f.category)) catMap.set(f.category, { name: f.category, count: 0, codes: new Set() });
    const item = catMap.get(f.category);
    item.count += 1;
    item.codes.add(f.code);
  });
  const categories = Array.from(catMap.values())
    .map(c => ({ name: c.name, count: c.count, codes: Array.from(c.codes) }))
    .sort((a, b) => b.count - a.count);

  const report = {
    generatedAt: nowStr(),
    meta: {
      total: recs.length,
      demo: demoAll.length,
      demoOk: demoAll.filter(r => r.status === 'playing').length,
      ok: ok.length,
      fail: fail.length,
      pending: pending.length + checking.length,
      evaluated,
      successRate: rate,
      durationMs: state.durationMs || 0,
      protocol: PROTO_LABEL[state.settings.protocol] || 'HLS',
      qualityLabel: QUALITY_LABEL[state.settings.quality] || '-',
      apiBase: (state.server && state.server.apiBase) || '',
      appKeyMasked: (state.server && state.server.appKeyMasked) || '',
      reportDir: (state.server && state.server.reportDir) || ''
    },
    failures,
    categories,
    conclusion: ''
  };
  report.conclusion = composeConclusion(report);
  return report;
}

function composeConclusion(report) {
  const m = report.meta;
  const lines = [];

  if (m.total === 0) {
    return '当前未配置任何监控通道，无法形成有效结论。请先添加通道并执行检测。';
  }

  if (!m.evaluated) {
    return `当前共配置 ${m.total} 路监控通道，但均处于未检测或已停止状态，尚未产生有效检测结果，`
      + '因此本报告不含成功/失败判定。请点击「重新检测全部」后重新生成报告。';
  }

  lines.push(`本次巡检共纳入 ${m.total} 路监控通道，其中成功出流 ${m.ok} 路、访问失败 ${m.fail} 路`
    + (m.pending ? `、未检测 ${m.pending} 路` : '')
    + `，已检测通道的成功率为 ${m.successRate}%。`);

  if (m.demo) {
    lines.push('');
    lines.push(`说明：上述 ${m.total} 路中有 ${m.demo} 路为演示通道（本地测试图），画面由本地生成，`
      + '不代表任何真实设备的可达性。评估真实覆盖情况或整改效果前，请先移除演示通道后重新生成报告。');
  }

  if (m.fail === 0) {
    lines.push('');
    lines.push('全部已检测通道均成功获取直播地址并出流，当前无需处置。建议保持每日至少一次巡检，'
      + '并关注设备上行带宽与平台并发限制。');
    return lines.join('\n');
  }

  const top = report.categories[0];
  const shares = report.categories
    .map(c => `${c.name} ${c.count} 路（占失败总数 ${Math.round((c.count / m.fail) * 100)}%，错误码 ${c.codes.join('/')}）`)
    .join('；');
  lines.push('');
  lines.push(`失败原因分布：${shares}。其中占比最高的是「${top.name}」（${top.count} 路），为本次的主要问题方向。`);

  lines.push('');
  lines.push('针对性建议：');
  const adviceByCat = {
    '设备状态': '确认相关设备供电与网络连通性，检查路由器 / 交换机端口状态；对频繁掉线的设备排查上行带宽与运营商链路质量。',
    '凭证鉴权': '重新获取 accessToken，并核对 AppKey / AppSecret 与账号归属；确认本机系统时间与标准时间偏差不超过 5 分钟。',
    '设备与权限': '逐一核对设备序列号，确认设备已添加至当前应用对应账号，必要时在开放平台完成设备授权。',
    '协议能力': '该批设备可能不支持 HLS，建议切换为 ezopen 协议播放，或联系萤石开通对应协议能力；同时可尝试将清晰度降为「流畅」。',
    '请求参数': '修正通道号与序列号格式，注意通道号从 1 开始且不超过设备实际通道数。',
    '网络': '检查本机出网策略、代理与防火墙，确认可稳定访问 open.ys7.com；企业网络环境下需放行对应域名与 443 端口。',
    '播放': '地址获取成功但未出流，通常为码流未就绪或 CDN 拒绝。建议重试并降低清晰度；如持续出现，检查设备推流状态。',
    '服务端': '萤石平台侧异常，建议间隔 10 分钟以上重试；若长期存在，向平台提交工单并附本报告的错误码明细。',
    '演示': '演示通道不产生真实码流，仅用于验证界面与报告流程；正式使用前请移除演示通道后重新生成报告。',
    '其他': '错误码未在内置映射表中，请对照萤石开放平台错误码文档进一步定位。'
  };
  report.categories.forEach((c, idx) => {
    const text = adviceByCat[c.name] || adviceByCat['其他'];
    lines.push(`${idx + 1}. ${c.name}（${c.count} 路）：${text}`);
  });

  lines.push('');
  lines.push('后续动作：优先处置占比最高的失败类型；对失败通道执行重试确认是否为瞬时故障；'
    + '稳态运行后建议将巡检频率设为每 30 分钟一次，并对连续 3 次失败的通道发起人工核查。');

  if (m.successRate < 60) {
    lines.push('');
    lines.push('风险提示：本次成功率低于 60%，监控覆盖存在明显缺口，建议在完成整改前对该场景补充人工巡检。');
  }
  return lines.join('\n');
}

function renderReport() {
  const r = buildReport();
  state.lastReport = r;
  const m = r.meta;

  let html = `
    <div class="kpis">
      <div class="kpi"><div class="v">${m.total}</div><div class="l">通道总数</div></div>
      <div class="kpi ok"><div class="v">${m.ok}</div><div class="l">访问成功</div></div>
      <div class="kpi bad"><div class="v">${m.fail}</div><div class="l">访问失败</div></div>
      <div class="kpi rate"><div class="v">${m.evaluated ? m.successRate + '%' : '—'}</div><div class="l">成功率</div></div>
    </div>
    <div class="muted">生成时间 ${r.generatedAt}　·　协议 ${m.protocol} / ${m.qualityLabel}　·　未检测 ${m.pending} 路${m.durationMs ? `　·　检测耗时 ${(m.durationMs / 1000).toFixed(1)} 秒` : ''}${m.demo ? `　·　含演示通道 ${m.demo} 路` : ''}</div>`;

  html += `<div class="sec-title">失败归类统计</div>`;
  if (!r.categories.length) {
    html += `<p class="muted">本次检测未出现访问失败。</p>`;
  } else {
    const max = Math.max(...r.categories.map(c => c.count));
    r.categories.forEach(c => {
      const pct = Math.round((c.count / max) * 100);
      html += `<div class="bar-row">
        <span title="${esc(c.codes.join(', '))}">${esc(c.name)}</span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>
        <span class="n">${c.count}</span>
      </div>`;
    });
  }

  html += `<div class="sec-title">失败明细（${r.failures.length} 条）</div>`;
  if (!r.failures.length) {
    html += `<p class="muted">无失败记录。</p>`;
  } else {
    html += `<table class="rep fixed"><colgroup>
      <col style="width:22%"><col style="width:17%"><col style="width:14%"><col style="width:33%"><col style="width:14%">
    </colgroup><thead><tr>
      <th>通道</th><th>序列号</th><th>错误码</th><th>描述</th><th>归类</th>
    </tr></thead><tbody>`;
    r.failures.forEach(f => {
      html += `<tr>
        <td>${esc(f.name)}<br><span class="muted">CH${f.channel} · ${f.protocol}</span></td>
        <td><span class="muted">${esc(f.serial)}</span></td>
        <td><code>${esc(f.code)}</code></td>
        <td class="wrap">${esc(f.message)}</td>
        <td>${esc(f.category)}</td>
      </tr>`;
    });
    html += `</tbody></table>`;
  }

  html += `<div class="sec-title">结论与建议</div>
    <div class="conclusion">${esc(r.conclusion)}</div>`;

  $('#reportBody').innerHTML = html;
}

function reportToCsv(r) {
  const head = ['序号', '通道名称', '设备序列号', '通道号', '协议', '错误码', '错误描述', '失败阶段', '失败归类', '重试次数', '最后尝试时间', '处理建议'];
  const rows = r.failures.map((f, i) => [
    i + 1, f.name, f.serial, f.channel, f.protocol, f.code, f.message, f.stage, f.category, f.attempts, f.lastTry, f.advice
  ]);
  const esc2 = (v) => {
    const s = String(v == null ? '' : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '\ufeff' + [head, ...rows].map(r2 => r2.map(esc2).join(',')).join('\r\n');
}

/* Markdown 表格单元格：竖线与换行会破坏表格结构，必须转义 */
function mdCell(v) {
  return String(v == null ? '' : v).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
}

function reportToMd(r) {
  const m = r.meta;
  const L = [];
  L.push('# 萤石云监控访问失败总结报告');
  L.push('');
  L.push(`> 生成时间：${r.generatedAt}　｜　协议 / 清晰度：${m.protocol} / ${m.qualityLabel}　｜　开放平台：${m.apiBase || '-'}`);
  L.push('');
  L.push('## 一、总体情况');
  L.push('');
  L.push('| 指标 | 数值 |');
  L.push('| --- | --- |');
  L.push(`| 检测通道总数 | ${m.total} |`);
  L.push(`| 访问成功 | ${m.ok} |`);
  L.push(`| 访问失败 | ${m.fail} |`);
  L.push(`| 未检测 | ${m.pending} |`);
  L.push(`| 成功率 | ${m.evaluated ? m.successRate + '%' : '未检测'} |`);
  if (m.demo) L.push(`| 其中演示通道 | ${m.demo} |`);
  L.push(`| AppKey | ${m.appKeyMasked || '未配置'} |`);
  L.push('');
  L.push('## 二、失败归类统计');
  L.push('');
  if (r.categories.length) {
    L.push('| 失败归类 | 数量 | 涉及错误码 |');
    L.push('| --- | --- | --- |');
    r.categories.forEach(c => L.push(`| ${mdCell(c.name)} | ${c.count} | ${mdCell(c.codes.join('、'))} |`));
  } else {
    L.push('本次检测未出现访问失败。');
  }
  L.push('');
  L.push('## 三、失败明细');
  L.push('');
  if (r.failures.length) {
    L.push('| # | 通道名称 | 序列号 | 通道 | 协议 | 错误码 | 错误描述 | 归类 | 重试 | 最后尝试 |');
    L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    r.failures.forEach((f, i) => L.push(`| ${i + 1} | ${mdCell(f.name)} | ${mdCell(f.serial)} | ${mdCell(f.channel)} | ${mdCell(f.protocol)} | \`${mdCell(f.code)}\` | ${mdCell(f.message)} | ${mdCell(f.category)} | ${f.attempts} | ${mdCell(f.lastTry)} |`));
    L.push('');
    L.push('### 逐条处理建议');
    L.push('');
    r.failures.forEach((f, i) => L.push(`${i + 1}. **${mdCell(f.name)}**（${mdCell(f.serial)}:${mdCell(f.channel)}）—— \`${mdCell(f.code)}\` ${mdCell(f.message)}　→　${mdCell(f.advice)}`));
  } else {
    L.push('无失败记录。');
  }
  L.push('');
  L.push('## 四、结论与建议');
  L.push('');
  L.push(r.conclusion);
  L.push('');
  L.push('## 五、说明');
  L.push('');
  L.push('1. 本报告基于萤石开放平台 `live/address/get` 接口实际返回结果生成；「地址获取成功」仅代表平台侧下发成功，最终出画仍依赖设备推流与网络状况。');
  L.push('2. 错误码含义以萤石开放平台官方文档为准。');
  L.push('3. 直播地址具时效性，过期后需重新获取。');
  return L.join('\n');
}

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 800);
}

/* ------------------------------------------------------------
   8. 全局动作
   ------------------------------------------------------------ */
function playAll() {
  Object.keys(state.cards).forEach(id => playCamera(id));
}

function retryAll() {
  const ids = Object.keys(state.cards);
  if (!ids.length) return toast('尚未添加通道', 'err');
  ids.forEach(id => playCamera(id));
  toast(`已发起 ${ids.length} 路重连`);
}

function stopAll() {
  Object.keys(state.cards).forEach(id => stopCamera(id));
  toast('已停止全部通道');
}

async function recheckAll() {
  const ids = Object.keys(state.cards);
  if (!ids.length) return toast('尚未添加通道', 'err');
  toast('正在重新检测 ' + ids.length + ' 路通道…');
  $('#btnRecheck').disabled = true;
  const t0 = performance.now();
  await Promise.all(ids.map(id => playCamera(id)));
  const elapsed = performance.now() - t0;
  state.durationMs = Math.round(elapsed);
  renderReport();
  $('#btnRecheck').disabled = false;
  const m = state.lastReport.meta;
  toast(`检测完成：成功 ${m.ok} 路 / 失败 ${m.fail} 路，耗时 ${(elapsed / 1000).toFixed(1)} 秒`,
    m.fail ? 'err' : 'ok');
}

/* ------------------------------------------------------------
   9. 弹窗 / 标签页
   ------------------------------------------------------------ */
function openModal(tab) {
  $('#modal').classList.add('open');
  switchTab(tab || 'batch');
  if (tab === 'cred') loadCredToForm();
}

function closeModal() { $('#modal').classList.remove('open'); }

function switchTab(name) {
  $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  $$('.modal-body').forEach(p => p.classList.toggle('active', p.dataset.pane === name));
}

function loadCredToForm() {
  const s = state.server || {};
  if (s.hasCreds) {
    // 已配置时留空表示沿用原值，避免用户只想改平台地址却被"不能为空"拦住
    $('#appKey').placeholder = '已配置：' + (s.appKeyMasked || '（已保存）') + '　留空表示不修改';
    const secret = $('#appSecret');
    if (secret) secret.placeholder = '已保存　留空表示不修改';
  }
  if (!$('#apiBase').value) $('#apiBase').value = s.apiBase || '';
}

/* 从任意文本中提取直链，并推导名称与有效期
   例：https://open.ys7.com/v3/openlive/GD0084509_1_1.m3u8?expire=1805358646&id=...&t=...
   - 允许前后夹带引号、括号、中文标点与说明文字
   - 从路径 GD0084509_1_1 推导出「设备 SN + 通道号」
   - 从 expire 参数解析到期时间（秒级） */
function parseDirectUrl(raw) {
  const text = String(raw || '');
  const m = text.match(/(?:https?|rtmp|ezopen):\/\/[^\s"'<>，。、；）)\]】]+/i);
  if (!m) return null;
  const url = m[0].replace(/[),.;]+$/, '');

  const protocol = /^ezopen/i.test(url) ? 1 : (/^rtmp/i.test(url) ? 3 : 2);

  let name = '直链通道';
  let expireAt = 0;
  try {
    const u = new URL(url);
    const file = (u.pathname.split('/').pop() || '').replace(/\.(m3u8|flv|mp4|m3u)$/i, '');
    // 萤石直链形如 GD0084509_1_1（设备序列号_通道_清晰度）
    const parts = file.split('_');
    if (parts.length >= 2 && /^[A-Za-z0-9]{4,}$/.test(parts[0]) && /^\d+$/.test(parts[1])) {
      name = `直链 ${parts[0]} 通道${parts[1]}`;
    } else if (file) {
      name = '直链 ' + file.slice(0, 24);
    } else {
      name = '直链 ' + u.hostname;
    }
    const exp = url.match(/[?&]expire=(\d{9,13})/i);
    if (exp) {
      let v = Number(exp[1]);
      if (v > 1e12) v = Math.floor(v / 1000);
      expireAt = v;
    }
  } catch (e) { /* 非法 URL 交给播放阶段兜底报错 */ }

  return { url, name, protocol, expireAt };
}

function parseBatch(text) {
  const out = [];
  const lines = text.split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    // 直链：整行任意位置出现 URL 即按直链处理
    if (/(?:https?|rtmp|ezopen):\/\//i.test(line)) {
      const direct = parseDirectUrl(line);
      if (direct) {
        out.push({
          name: direct.name, serial: '', channel: 1,
          directUrl: direct.url, protocol: direct.protocol, expireAt: direct.expireAt
        });
        continue;
      }
    }

    const parts = line.split(/[:：,，|]/).map(s => s.trim()).filter(Boolean);
    if (!parts.length) continue;
    const serial = parts[0];
    let channel = 1;
    let name = '';
    if (parts.length >= 2 && /^\d+$/.test(parts[1])) {
      channel = parseInt(parts[1], 10) || 1;
      name = parts.slice(2).join(':');
    } else {
      name = parts.slice(1).join(':');
    }
    out.push({
      name: name || (serial + ' 通道' + channel),
      serial,
      channel,
      protocol: parseInt($('#protoSel').value, 10) || 2,
      quality: parseInt($('#qualitySel').value, 10) || 2
    });
  }
  return out;
}

async function loadDevices() {
  const box = $('#deviceList');
  box.innerHTML = '<p class="muted">正在读取设备列表…</p>';
  const res = await api('/api/devices', { pageStart: 0, pageSize: 50 });
  if (!res.ok) {
    box.innerHTML = `<p class="muted" style="color:#ef8f8f">读取失败：${esc(res.error.message)}（错误码 ${esc(res.error.code)}）</p>`;
    return;
  }
  const list = Array.isArray(res.data) ? res.data : [];
  if (!list.length) {
    box.innerHTML = '<p class="muted">该账号下暂无设备。</p>';
    return;
  }
  box.innerHTML = '';
  list.forEach(dev => {
    const online = dev.status === 1 || dev.status === '1' || dev.status === true;
    const item = document.createElement('div');
    item.className = 'dev-item ' + (online ? 'on' : 'off');
    item.innerHTML = `
      <span class="badge ${online ? 'ok' : 'bad'}">${online ? '在线' : '离线'}</span>
      <span class="nm">${esc(dev.deviceName || dev.name || '未命名设备')}</span>
      <span class="sn">${esc(dev.deviceSerial || dev.serial || '')}</span>
      <span class="grow"></span>
      <button class="mini" data-serial="${esc(dev.deviceSerial || dev.serial || '')}">查看通道</button>`;
    item.querySelector('button').addEventListener('click', () => loadChannels(dev));
    box.appendChild(item);
  });
}

async function loadChannels(dev) {
  const serial = dev.deviceSerial || dev.serial || '';
  const box = $('#cameraList');
  box.innerHTML = '<p class="muted">正在读取通道…</p>';
  const res = await api('/api/cameras', { serial });
  if (!res.ok) {
    box.innerHTML = `<p class="muted" style="color:#ef8f8f">通道读取失败：${esc(res.error.message)}（${esc(res.error.code)}）</p>`;
    return;
  }
  const list = Array.isArray(res.data) ? res.data : [];
  box.innerHTML = `<p class="label">${esc(dev.deviceName || serial)} 的通道：</p>`;
  if (!list.length) {
    box.insertAdjacentHTML('beforeend', '<p class="muted">该设备未返回通道信息，可尝试直接按序列号添加（通道 1）。</p>');
    return;
  }
  list.forEach(cam => {
    const ch = cam.channelNo || cam.channel || 1;
    const nm = cam.channelName || cam.name || ('通道' + ch);
    const item = document.createElement('div');
    item.className = 'dev-item';
    item.innerHTML = `
      <span class="badge info">CH${ch}</span>
      <span class="nm">${esc(nm)}</span>
      <span class="sn">${esc(serial)}:${ch}</span>
      <span class="grow"></span>
      <button class="mini">添加</button>`;
    item.querySelector('button').addEventListener('click', () => {
      addCameras([{
        name: nm, serial, channel: ch,
        protocol: parseInt($('#protoSel').value, 10) || 2,
        quality: parseInt($('#qualitySel').value, 10) || 2
      }], $('#autoPlayChk').checked);
      toast('已添加：' + nm, 'ok');
    });
    box.appendChild(item);
  });
}

async function saveCred() {
  const appKey = $('#appKey').value.trim();
  const appSecret = $('#appSecret').value.trim();
  const apiBase = $('#apiBase').value.trim();
  const out = $('#credResult');
  const hasCred = !!(state.server && state.server.hasCreds);

  // 留空 = 沿用已保存的凭证，只在首次配置时强制要求成对填写
  if (!appKey && !appSecret && !hasCred) {
    out.style.color = '#ef8f8f';
    out.textContent = '首次配置需要同时填写 AppKey 与 AppSecret。';
    return;
  }
  if (!appKey && !appSecret && !apiBase) {
    out.style.color = '#ef8f8f';
    out.textContent = '没有需要保存的改动。若要更换凭证请填写 AppKey 与 AppSecret。';
    return;
  }

  const payload = { apiBase };
  if (appKey) payload.appKey = appKey;
  if (appSecret) payload.appSecret = appSecret;

  out.style.color = '';
  out.textContent = '正在保存…';
  const res = await api('/api/config', payload);
  if (!res.ok) {
    out.style.color = '#ef8f8f';
    out.textContent = `保存失败：${res.error.message}（错误码 ${res.error.code}）`;
    return;
  }

  if (res.data.tokenVerified) {
    out.style.color = '#9ff0b6';
    out.textContent = `凭证可用，Token 有效期至 ${new Date(res.data.tokenExpireAt * 1000).toLocaleString()}。`;
    toast('凭证已保存，Token 获取成功', 'ok');
  } else {
    out.style.color = '#ffd18a';
    out.textContent = '设置已保存，但当前没有可用凭证，Token 未获取。可直接使用 m3u8 直链，或补齐 AppKey / AppSecret。';
    toast('设置已保存（未获取 Token）', 'warn');
  }
  await refreshServerState();
}

/* ------------------------------------------------------------
   10. 服务状态
   ------------------------------------------------------------ */
async function refreshServerState() {
  const res = await api('/api/state');
  if (!res.ok) {
    $('#credChip').textContent = '本地服务未连接';
    $('#credChip').className = 'chip bad';
    return false;
  }
  state.server = res.data;
  $('#ver').textContent = 'v' + res.data.version;

  const chip = $('#credChip');
  if (res.data.tokenValid) {
    const expire = new Date(res.data.tokenExpireAt * 1000);
    chip.textContent = '已连接 · Token 有效至 ' + expire.toLocaleTimeString();
    chip.className = 'chip ok';
  } else if (res.data.hasCreds) {
    chip.textContent = '已配置凭证 · Token 待获取';
    chip.className = 'chip warn';
  } else {
    chip.textContent = '凭证未配置';
    chip.className = 'chip warn';
  }
  return true;
}

/* ------------------------------------------------------------
   11. 事件绑定与初始化
   ------------------------------------------------------------ */
function bindEvents() {
  $('#layoutSel').addEventListener('change', (e) => {
    state.layout = parseInt(e.target.value, 10);
    $('#grid').dataset.layout = String(state.layout);
    saveLocal();
  });

  $('#btnAdd').addEventListener('click', () => openModal('batch'));
  $('#btnAdd2').addEventListener('click', () => openModal('batch'));
  $('#btnCloseModal').addEventListener('click', closeModal);
  $('#btnCancel').addEventListener('click', closeModal);

  $('#btnPlayAll').addEventListener('click', playAll);
  $('#btnRetryAll').addEventListener('click', retryAll);
  $('#btnStopAll').addEventListener('click', stopAll);

  $('#btnReport').addEventListener('click', () => {
    renderReport();
    $('#drawer').classList.add('open');
    $('#scrim').classList.add('open');
  });
  $('#btnCloseDrawer').addEventListener('click', () => {
    $('#drawer').classList.remove('open');
    $('#scrim').classList.remove('open');
  });
  $('#scrim').addEventListener('click', () => {
    $('#drawer').classList.remove('open');
    $('#scrim').classList.remove('open');
  });

  $('#btnRecheck').addEventListener('click', recheckAll);

  $('#btnSaveReport').addEventListener('click', async () => {
    // 始终重建：抽屉打开期间通道状态可能已变化，直接取 lastReport 会保存旧快照
    renderReport();
    const r = state.lastReport;
    const res = await api('/api/report/save', { report: r });
    if (!res.ok) return toast('保存失败：' + res.error.message, 'err');
    toast('报告已保存：' + res.data.md, 'ok');
    window.__lastReportFiles = res.data;
  });

  $('#btnExportCsv').addEventListener('click', () => {
    renderReport();
    download(`访问失败报告_${Date.now()}.csv`, reportToCsv(state.lastReport), 'text/csv;charset=utf-8');
  });

  $('#btnExportMd').addEventListener('click', () => {
    renderReport();
    download(`访问失败报告_${Date.now()}.md`, reportToMd(state.lastReport), 'text/markdown;charset=utf-8');
  });

  $$('.tab').forEach(tab => tab.addEventListener('click', () => switchTab(tab.dataset.tab)));

  $('#btnConfirmBatch').addEventListener('click', () => {
    const list = parseBatch($('#batchInput').value);
    if (!list.length) return toast('未解析到有效通道，请检查格式', 'err');
    addCameras(list, $('#autoPlayChk').checked);
    $('#batchInput').value = '';
    closeModal();
    toast(`已添加 ${list.length} 路通道`, 'ok');
  });

  $('#btnLoadDevices').addEventListener('click', loadDevices);
  $('#btnLoadToken').addEventListener('click', async () => {
    const res = await api('/api/token');
    if (res.ok) toast('Token 可用，有效期至 ' + new Date(res.data.expireAt * 1000).toLocaleString(), 'ok');
    else toast('获取失败：' + res.error.message, 'err');
  });

  $('#btnSaveCred').addEventListener('click', saveCred);
  $('#btnClearToken').addEventListener('click', async () => {
    const res = await api('/api/config/clear', {});
    if (res.ok) { toast('本地 Token 已清除', 'ok'); refreshServerState(); }
  });

  $('#btnDemo').addEventListener('click', () => {
    loadDemoCameras(true);
    toast('已载入 3 路演示通道（含 1 路模拟失败）', 'ok');
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      $('#drawer').classList.remove('open');
      $('#scrim').classList.remove('open');
    }
    if (e.key === 'r' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      renderReport();
      $('#drawer').classList.add('open');
      $('#scrim').classList.add('open');
    }
  });
}

function tickClock() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  $('#clock').textContent = `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/* 直播地址到期前自动续期（剩余 < 90 秒时重新取址）
   直链无法续期，到期即报错，提示重新获取地址 */
function startExpiryWatcher() {
  setInterval(() => {
    const now = Math.floor(Date.now() / 1000);
    Object.values(state.cards).forEach(rec => {
      if (rec.demo || !rec.expireAt) return;

      if (rec.directUrl) {
        if (rec.status === 'playing' && now > rec.expireAt) {
          setError(rec, 'URL_EXPIRED', '链接已于 ' + new Date(rec.expireAt * 1000).toLocaleString() + ' 过期');
        }
        return;
      }
      if (rec.status === 'playing' && now > rec.expireAt - 90) {
        playCamera(rec.id, { soft: true });
      }
    });
    Object.keys(state.cards).forEach(id => {
      const rec = state.cards[id];
      if (rec.status === 'playing' && rec.expireAt) paintCard(id);
    });
  }, 30000);
}

/* 直接用 file:// 打开页面时给出明确指引，避免"打开是空白/一直在转"的误解 */
function renderProtocolNotice() {
  document.body.innerHTML = `
    <div style="position:fixed;inset:0;display:flex;align-items:center;justify-content:center;
                background:#0a0e13;color:#dbe6f2;font:14px/1.7 'Microsoft YaHei',system-ui;padding:24px;">
      <div style="max-width:640px;background:#131b25;border:1px solid #22303f;border-radius:12px;padding:28px 30px;">
        <div style="font-size:18px;font-weight:700;margin-bottom:10px;color:#22d3ee;">请通过本地服务访问</div>
        <p style="margin:0 0 14px;color:#8fa3b8;">
          当前是以 <code style="color:#ffb4b4;">file://</code> 方式直接打开页面，浏览器的安全策略会阻止
          与本地服务的通信，因此画面与数据都无法加载。
        </p>
        <p style="margin:0 0 8px;color:#dbe6f2;font-weight:600;">正确方式：</p>
        <ol style="margin:0 0 16px;padding-left:22px;color:#8fa3b8;">
          <li>回到工具目录，双击 <b style="color:#dbe6f2;">启动监控墙.bat</b></li>
          <li>浏览器会自动打开 <code style="color:#9ff0b6;">http://127.0.0.1:8770/</code></li>
          <li>若未自动打开，手动在地址栏输入上述地址</li>
        </ol>
        <p style="margin:0;color:#5f7488;font-size:12.5px;">
          命令行方式：在该目录执行 <code>python server.py</code>
        </p>
      </div>
    </div>`;
}

async function init() {
  if (location.protocol === 'file:') { renderProtocolNotice(); return; }

  loadLocal();
  $('#grid').dataset.layout = String(state.layout);
  $('#layoutSel').value = String(state.layout);
  bindEvents();
  tickClock();
  setInterval(tickClock, 1000);

  // 恢复通道
  const restored = [];
  state.cameras.forEach(c => {
    const rec = Object.assign({
      status: 'idle', error: null, attempts: 0, latency: 0, expireAt: 0, lastTry: '', lastOk: ''
    }, c);
    state.cards[rec.id] = rec;
    $('#grid').appendChild(buildCard(rec));
    paintCard(rec.id);
    restored.push(rec.id);
  });
  refreshEmpty();

  // 演示模式：?demo=1 自动载入演示通道，用于验证界面与报告流程
  const params = new URLSearchParams(location.search);
  if (params.get('demo') === '1' && !state.cameras.length) {
    loadDemoCameras(true);
  }

  const online = await refreshServerState();
  if (online) {
    setInterval(refreshServerState, 60000);
    startExpiryWatcher();
  } else {
    toast('本地服务未连接，请确认 server.py 已启动', 'err');
  }

  // 恢复的通道自动上线（错峰发起，避免瞬时并发）
  restored.forEach((id, i) => setTimeout(() => playCamera(id), 300 + i * 280));
}

document.addEventListener('DOMContentLoaded', init);
