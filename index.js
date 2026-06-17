const mineflayer  = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const { GoalNear } = goals;
const TelegramBot  = require('node-telegram-bot-api');
const fs           = require('fs');
const path         = require('path');

// ── دعم متغيرات البيئة (Railway) أو config.json (محلي) ──────
let config;
try {
  config = require('./config.json');
  // دمج متغيرات البيئة فوق config.json إن وُجدت
  if (process.env.TELEGRAM_TOKEN)   config.telegram.token     = process.env.TELEGRAM_TOKEN;
  if (process.env.TELEGRAM_CHAT_ID) config.telegram.chatId    = process.env.TELEGRAM_CHAT_ID;
  if (process.env.SERVER_HOST)      config.server.host        = process.env.SERVER_HOST;
  if (process.env.SERVER_PORT)      config.server.port        = parseInt(process.env.SERVER_PORT);
  if (process.env.BOT_USERNAME)     config.bot.username       = process.env.BOT_USERNAME;
  if (process.env.BOT_AUTH)         config.bot.auth           = process.env.BOT_AUTH;
  if (process.env.SERVER_VERSION)   config.server.version     = process.env.SERVER_VERSION;
} catch (_) {
  // Railway: لا يوجد config.json — استخدم متغيرات البيئة فقط
  config = {
    server: {
      host:    process.env.SERVER_HOST    || 'localhost',
      port:    parseInt(process.env.SERVER_PORT) || 25565,
      version: process.env.SERVER_VERSION || '1.20.1',
    },
    bot: {
      username: process.env.BOT_USERNAME || 'BotPlayer',
      auth:     process.env.BOT_AUTH     || 'offline',
    },
    telegram: {
      token:       process.env.TELEGRAM_TOKEN    || '',
      chatId:      process.env.TELEGRAM_CHAT_ID  || '',
      forwardChat: process.env.FORWARD_CHAT !== 'false',
    },
    settings: {
      reconnectDelay:  parseInt(process.env.RECONNECT_DELAY)  || 5000,
      wanderRadius:    parseInt(process.env.WANDER_RADIUS)    || 30,
      wanderInterval:  parseInt(process.env.WANDER_INTERVAL)  || 10000,
    },
  };
}

// ═══════════════════════════════════════════════════════════════
//  ألوان الكونسول
// ═══════════════════════════════════════════════════════════════
const C = {
  reset:'\x1b[0m', bold:'\x1b[1m',
  green:'\x1b[32m', yellow:'\x1b[33m',
  red:'\x1b[31m', cyan:'\x1b[36m',
  magenta:'\x1b[35m', blue:'\x1b[34m',
};
function log(level, msg, botId = '') {
  const t  = new Date().toLocaleTimeString('ar-MA', { hour12: false });
  const id = botId ? `[${C.bold}${botId}${C.reset}] ` : '';
  const px = {
    info:    `${C.cyan}[${t}] [INFO]  ${C.reset}`,
    success: `${C.green}[${t}] [✓ OK] ${C.reset}`,
    warn:    `${C.yellow}[${t}] [⚠]   ${C.reset}`,
    error:   `${C.red}[${t}] [✗]   ${C.reset}`,
    bot:     `${C.magenta}[${t}] [BOT]  ${C.reset}`,
    tg:      `${C.blue}[${t}] [TG]   ${C.reset}`,
  };
  console.log((px[level] || px.info) + id + msg);
}

// ═══════════════════════════════════════════════════════════════
//  حفظ / تحميل البوتات من bots.json
// ═══════════════════════════════════════════════════════════════
const BOTS_FILE = path.join(__dirname, 'bots.json');

function loadBotsConfig() {
  try {
    return JSON.parse(fs.readFileSync(BOTS_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

function saveBotsConfig() {
  const data = [];
  for (const [id, s] of botsMap) {
    data.push({ id, host: s.host, port: s.port, username: s.username, version: s.version, password: s.password });
  }
  fs.writeFileSync(BOTS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// توليد كلمة مرور عشوائية قوية
function generatePassword(len = 10) {
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let pass = '';
  for (let i = 0; i < len; i++) pass += chars[Math.floor(Math.random() * chars.length)];
  return pass;
}

// ═══════════════════════════════════════════════════════════════
//  خريطة البوتات
//  botsMap: botId → BotState
//  BotState = { id, host, port, username, version,
//               bot, isConnected, isBotRunning,
//               reconnectCount, startTime,
//               wanderTimer, reconnectTimer }
// ═══════════════════════════════════════════════════════════════
const botsMap = new Map();
let   botCounter = 0;   // لتوليد IDs: b1, b2, ...

function newBotId() {
  botCounter++;
  return `b${botCounter}`;
}

function createBotState(id, host, port, username = 'BotPlayer', version = '1.20.1', password = null) {
  return {
    id, host, port,
    username,
    currentUsername: username,
    password: password || generatePassword(), // كلمة مرور محفوظة للتسجيل التلقائي
    version,
    bot: null,
    isConnected: false,
    isBotRunning: false,
    reconnectCount: 0,
    startTime: Date.now(),
    wanderTimer: null,
    reconnectTimer: null,
    stuckTimer: null,
    lastPos: null,
    wanderOrigin: null,
    lastWanderTime: 0,
    isWandering: false,
    isRegistered: false,   // هل سجّل في هذه الجلسة
  };
}

// ── قائمة أسماء للتدوير عند إعادة الاتصال ─────────────────────
const USERNAME_POOL = [
  'Steve', 'Alex', 'Notch', 'Herobrine', 'Dream', 'Technoblade',
  'PhoenixSC', 'Skeppy', 'BadBoyHalo', 'Sapnap', 'GeorgeNotFound',
  'TommyInnit', 'Wilbur', 'Tubbo', 'Ranboo', 'Quackity',
  'xNestorio', 'Purpled', 'Punz', 'Antfrost', 'CaptainPuffy',
  'Fundy', 'Eret', 'Nihachu', 'Karl', 'HBomb', 'Vikk', 'Lazar',
  'Craft', 'Miner', 'Builder', 'Ranger', 'Knight', 'Wizard',
  'Shadow', 'Ghost', 'Storm', 'Blaze', 'Frost', 'Ember',
  'Viper', 'Hawk', 'Wolf', 'Bear', 'Fox', 'Eagle', 'Lion',
];

function getNextUsername(s) {
  // إذا كان الاسم الأساسي ثابتاً، أضف رقماً عشوائياً
  const base = s.username || 'Player';
  // اختر اسماً عشوائياً من المجموعة + رقم عشوائي
  const pick = USERNAME_POOL[Math.floor(Math.random() * USERNAME_POOL.length)];
  const num  = Math.floor(Math.random() * 9000) + 1000;
  // في أول اتصال استخدم الاسم الأصلي، ثم غيّره
  if (s.reconnectCount === 0) return base;
  return `${pick}${num}`;
}

// ═══════════════════════════════════════════════════════════════
//  تيليجرام
// ═══════════════════════════════════════════════════════════════
let tg = null;

// حالة انتظار المدخل لكل محادثة
// pendingAction: chatId → { type, botId?, targetUser? }
const pendingAction = new Map();

// ── إرسال إشعار ──────────────────────────────────────────────
function notify(text, keyboard = null) {
  if (!tg || !config.telegram.chatId) return;
  const opts = { parse_mode: 'Markdown' };
  if (keyboard) opts.reply_markup = keyboard;
  tg.sendMessage(config.telegram.chatId, text, opts).catch(() => {});
}

function send(chatId, text, keyboard = null) {
  if (!tg) return;
  const opts = { parse_mode: 'Markdown' };
  if (keyboard) opts.reply_markup = keyboard;
  tg.sendMessage(chatId, text, opts).catch(() => {});
}

// ═══════════════════════════════════════════════════════════════
//  لوحات المفاتيح
// ═══════════════════════════════════════════════════════════════

// القائمة الرئيسية: تعرض كل البوتات + زر إضافة
function mainMenuKeyboard() {
  const rows = [];
  for (const [id, s] of botsMap) {
    const icon = s.isConnected ? '🟢' : '🔴';
    rows.push([{ text: `${icon} ${id}: ${s.host}:${s.port}`, callback_data: `sel:${id}` }]);
  }
  rows.push([{ text: '➕ إضافة بوت جديد', callback_data: 'add' }]);
  return { inline_keyboard: rows };
}

// قائمة بوت محدد
function botMenuKeyboard(id) {
  const s = botsMap.get(id);
  if (!s) return mainMenuKeyboard();
  return {
    inline_keyboard: [
      [
        s.isConnected
          ? { text: '🔴 إيقاف',        callback_data: `${id}:off` }
          : { text: '🟢 تشغيل',        callback_data: `${id}:on`  },
        { text: '🔄 إعادة الاتصال',    callback_data: `${id}:rc`  },
      ],
      [
        { text: '👥 اللاعبون',         callback_data: `${id}:pl`  },
        { text: '⏱️ مدة التشغيل',      callback_data: `${id}:up`  },
      ],
      [
        { text: '📍 الموقع',           callback_data: `${id}:pos` },
        { text: '📊 الحالة',           callback_data: `${id}:st`  },
      ],
      [
        { text: '💬 إرسال رسالة',      callback_data: `${id}:ch`  },
        { text: '🔧 تغيير السيرفر',    callback_data: `${id}:sv`  },
      ],
      [
        { text: '🧩 تغيير الإصدار',    callback_data: `${id}:ver` },
        { text: '✏️ تغيير اسم البوت',  callback_data: `${id}:nm`  },
      ],
      [
        { text: '🗑️ حذف هذا البوت',   callback_data: `${id}:del` },
        { text: '↩️ القائمة الرئيسية', callback_data: 'main'      },
      ],
    ],
  };
}

// ═══════════════════════════════════════════════════════════════
//  تهيئة تيليجرام
// ═══════════════════════════════════════════════════════════════
function initTelegram() {
  if (!config.telegram.token || config.telegram.token === 'YOUR_TELEGRAM_BOT_TOKEN') {
    log('warn', 'تيليجرام: التوكن غير مضبوط');
    return;
  }
  tg = new TelegramBot(config.telegram.token, { polling: true });
  log('tg', `${C.bold}بوت تيليجرام يعمل ✅${C.reset}`);

  // ── /start ────────────────────────────────────────────────
  tg.onText(/\/start/, (msg) => {
    send(msg.chat.id,
      `🤖 *مرحباً في نظام إدارة البوتات!*\n\nعدد البوتات: ${botsMap.size}\n\nاختر بوتاً أو أضف جديداً 👇`,
      mainMenuKeyboard()
    );
  });

  tg.onText(/\/menu/, (msg) => {
    send(msg.chat.id, `🎮 *القائمة الرئيسية*\nعدد البوتات: ${botsMap.size}`, mainMenuKeyboard());
  });

  // ── استقبال النصوص ───────────────────────────────────────
  tg.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    const chatId = msg.chat.id;
    const text   = msg.text.trim();
    const action = pendingAction.get(chatId);
    if (!action) return;
    pendingAction.delete(chatId);

    // ── خطوة 1: استقبال السيرفر ──────────────────────────
    if (action.type === 'new_bot_server') {
      let host = text, port = 25565;
      if (text.includes(':')) {
        const p = text.split(':');
        host = p[0].trim();
        port = parseInt(p[1]) || 25565;
      }
      if (!host) {
        send(chatId, '❌ عنوان غير صحيح! مثال: `play.server.net:25565`', mainMenuKeyboard());
        return;
      }
      pendingAction.set(chatId, { type: 'new_bot_version', host, port });
      send(chatId,
        `✅ السيرفر: \`${host}:${port}\`\n\n` +
        `🧩 *الخطوة 2/3 — أرسل إصدار السيرفر:*\n` +
        `_مثال: \`1.20.1\`، \`1.20.2\`، \`1.19.4\`..._`
      );
      return;
    }

    // ── خطوة 2: استقبال الإصدار ──────────────────────────
    if (action.type === 'new_bot_version') {
      const version = text.trim();
      const { host, port } = action;
      pendingAction.set(chatId, { type: 'new_bot_name', host, port, version });
      send(chatId,
        `✅ الإصدار: \`${version}\`\n\n` +
        `✏️ *الخطوة 3/3 — أرسل اسم البوت:*\n` +
        `_مثال: \`CoolBot\` أو \`Player123\` (ماكسيموم 16 حرف)_`
      );
      return;
    }

    // ── خطوة 2: استقبال اسم البوت وإنشاؤه ──────────────
    if (action.type === 'new_bot_name') {
      const username = text.replace(/\s+/g, '_').slice(0, 16);
      const { host, port, version } = action;
      const id    = newBotId();
      const state = createBotState(id, host, port, username, version);
      botsMap.set(id, state);
      saveBotsConfig();
      send(chatId,
        `🎉 *تم إنشاء البوت \`${id}\`!*\n\n` +
        `🌐 السيرفر: \`${host}:${port}\`\n` +
        `🧩 الإصدار: \`${version}\`\n` +
        `👤 الاسم: \`${username}\`\n\n` +
        `🔄 جاري الاتصال...`,
        botMenuKeyboard(id)
      );
      log('info', `بوت جديد: ${id} (${username}) → ${host}:${port} [${version}]`);
      startBot(id);
      return;
    }

    // ── تغيير اسم البوت ──────────────────────────────────
    if (action.type === 'rename') {
      const s = botsMap.get(action.botId);
      if (!s) { send(chatId, '❌ البوت غير موجود!', mainMenuKeyboard()); return; }
      const newName = text.replace(/\s+/g, '_').slice(0, 16);
      const oldName = s.username;
      s.username = newName;
      saveBotsConfig();
      stopBot(action.botId);
      setTimeout(() => startBot(action.botId), 1000);
      send(chatId,
        `✅ *تم تغيير اسم \`${action.botId}\`!*\n\n` +
        `من: \`${oldName}\`\nإلى: \`${newName}\`\n\n` +
        `🔄 جاري إعادة الاتصال بالاسم الجديد...`,
        botMenuKeyboard(action.botId)
      );
      log('info', `تغيير اسم ${action.botId}: ${oldName} → ${newName}`);
      return;
    }

    // ── تغيير إصدار البوت ─────────────────────────────────
    if (action.type === 'version') {
      const s = botsMap.get(action.botId);
      if (!s) { send(chatId, '❌ البوت غير موجود!', mainMenuKeyboard()); return; }
      const newVer = text.trim();
      const oldVer = s.version;
      s.version = newVer;
      saveBotsConfig();
      stopBot(action.botId);
      setTimeout(() => startBot(action.botId), 1000);
      send(chatId,
        `✅ *تم تغيير إصدار \`${action.botId}\`!*\n\n` +
        `من: \`${oldVer}\`\nإلى: \`${newVer}\`\n\n` +
        `🔄 جاري إعادة الاتصال...`,
        botMenuKeyboard(action.botId)
      );
      log('info', `تغيير إصدار ${action.botId}: ${oldVer} → ${newVer}`);
      return;
    }

    // ── إرسال رسالة للسيرفر ──────────────────────────────
    if (action.type === 'chat') {
      const s = botsMap.get(action.botId);
      if (!s || !s.isConnected || !s.bot) {
        send(chatId, '❌ البوت غير متصل!', botMenuKeyboard(action.botId));
        return;
      }
      try {
        s.bot.chat(text);
        send(chatId, `✅ *تم الإرسال عبر \`${action.botId}\`:*\n💬 ${text}`, botMenuKeyboard(action.botId));
        log('tg', `رسالة للسيرفر: ${text}`, action.botId);
      } catch (e) {
        send(chatId, `❌ خطأ: ${e.message}`, botMenuKeyboard(action.botId));
      }
      return;
    }

    // ── تغيير السيرفر ────────────────────────────────────
    if (action.type === 'server') {
      const s = botsMap.get(action.botId);
      if (!s) { send(chatId, '❌ البوت غير موجود!', mainMenuKeyboard()); return; }
      let host = text, port = 25565;
      if (text.includes(':')) {
        const p = text.split(':');
        host = p[0].trim();
        port = parseInt(p[1]) || 25565;
      }
      if (!host) { send(chatId, '❌ عنوان غير صحيح!', botMenuKeyboard(action.botId)); return; }
      s.host = host;
      s.port = port;
      saveBotsConfig();
      stopBot(action.botId);
      send(chatId,
        `✅ *تم تغيير سيرفر \`${action.botId}\`!*\n\n🌐 \`${host}:${port}\`\n🔄 جاري الاتصال...`,
        botMenuKeyboard(action.botId)
      );
      setTimeout(() => startBot(action.botId), 1500);
      return;
    }

    // ── الرد على رسالة خاصة ──────────────────────────────
    if (action.type === 'whisper') {
      const s = botsMap.get(action.botId);
      if (!s || !s.isConnected || !s.bot) {
        send(chatId, '❌ البوت غير متصل!', botMenuKeyboard(action.botId));
        return;
      }
      try {
        s.bot.chat(`/msg ${action.targetUser} ${text}`);
        send(chatId,
          `✅ *رد على \`${action.targetUser}\` عبر \`${action.botId}\`:*\n💬 ${text}`,
          botMenuKeyboard(action.botId)
        );
      } catch (e) {
        send(chatId, `❌ خطأ: ${e.message}`);
      }
      return;
    }
  });

  // ── Inline Buttons ────────────────────────────────────────
  tg.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data   = query.data;
    await tg.answerCallbackQuery(query.id).catch(() => {});

    // ── القائمة الرئيسية ─────────────────────────────────
    if (data === 'main') {
      send(chatId, `🎮 *القائمة الرئيسية*\nعدد البوتات: ${botsMap.size}`, mainMenuKeyboard());
      return;
    }

    // ── إضافة بوت ────────────────────────────────────────
    if (data === 'add') {
      pendingAction.set(chatId, { type: 'new_bot_server' });
      send(chatId,
        `➕ *إضافة بوت جديد — الخطوة 1/3*\n\n` +
        `أرسل عنوان السيرفر:\n\`IP:PORT\`\n\n` +
        `مثال:\n\`play.hypixel.net:25565\`\nأو فقط: \`play.hypixel.net\``
      );
      return;
    }

    // ── اختيار بوت ───────────────────────────────────────
    if (data.startsWith('sel:')) {
      const id = data.slice(4);
      const s  = botsMap.get(id);
      if (!s) { send(chatId, '❌ البوت غير موجود!', mainMenuKeyboard()); return; }
      const icon = s.isConnected ? '🟢 متصل' : '🔴 غير متصل';
      send(chatId,
        `🤖 *البوت \`${id}\`*\n\n🌐 \`${s.host}:${s.port}\`\n👤 الاسم: \`${s.currentUsername || s.username}\`\n🔌 ${icon}\n🔄 اتصالات: ${s.reconnectCount}\n\nاختر أمراً 👇`,
        botMenuKeyboard(id)
      );
      return;
    }

    // ── الرد على رسالة خاصة ──────────────────────────────
    if (data.startsWith('wr:')) {
      const parts      = data.split(':');
      const botId      = parts[1];
      const targetUser = parts.slice(2).join(':');
      const s = botsMap.get(botId);
      if (!s || !s.isConnected) {
        send(chatId, '❌ البوت غير متصل!');
        return;
      }
      pendingAction.set(chatId, { type: 'whisper', botId, targetUser });
      send(chatId, `↩️ *الرد على \`${targetUser}\` عبر \`${botId}\`:*\nاكتب ردك الآن 👇`);
      return;
    }

    // ── أوامر البوت المحددة: {id}:{cmd} ─────────────────
    if (data.includes(':')) {
      const colonIdx = data.indexOf(':');
      const id  = data.slice(0, colonIdx);
      const cmd = data.slice(colonIdx + 1);
      const s   = botsMap.get(id);

      if (!s && cmd !== 'del') {
        send(chatId, '❌ البوت غير موجود!', mainMenuKeyboard());
        return;
      }

      switch (cmd) {

        case 'on':
          if (s.isConnected) {
            send(chatId, `⚠️ \`${id}\` متصل بالفعل!`, botMenuKeyboard(id));
          } else {
            send(chatId, `🔄 تشغيل \`${id}\`...`);
            startBot(id);
            setTimeout(() => send(chatId, `✅ تم!`, botMenuKeyboard(id)), 2000);
          }
          break;

        case 'off':
          stopBot(id);
          send(chatId, `🔴 *تم إيقاف \`${id}\`*`, botMenuKeyboard(id));
          break;

        case 'rc':
          send(chatId, `🔄 إعادة اتصال \`${id}\`...`);
          stopBot(id);
          setTimeout(() => { startBot(id); send(chatId, `✅ تمت إعادة الاتصال!`, botMenuKeyboard(id)); }, 1500);
          break;

        case 'pl':
          if (!s.isConnected || !s.bot) {
            send(chatId, `❌ \`${id}\` غير متصل!`, botMenuKeyboard(id));
          } else {
            const players = Object.keys(s.bot.players);
            const list    = players.length === 0
              ? 'لا يوجد لاعبون متصلون.'
              : players.map((p, i) => `  ${i+1}. 👤 \`${p}\``).join('\n');
            send(chatId,
              `👥 *لاعبو \`${id}\` (${s.host}):*\n\n${list}`,
              botMenuKeyboard(id)
            );
          }
          break;

        case 'up': {
          const sec = Math.floor((Date.now() - s.startTime) / 1000);
          const h = Math.floor(sec / 3600), m = Math.floor((sec%3600)/60), ss = sec%60;
          send(chatId,
            `⏱️ *\`${id}\` — مدة التشغيل*\n\n🕐 ${h}س ${m}د ${ss}ث\n🔄 اتصالات: ${s.reconnectCount}`,
            botMenuKeyboard(id)
          );
          break;
        }

        case 'pos':
          if (!s.isConnected || !s.bot || !s.bot.entity) {
            send(chatId, `❌ \`${id}\` غير متصل!`, botMenuKeyboard(id));
          } else {
            const p = s.bot.entity.position;
            send(chatId,
              `📍 *موقع \`${id}\`*\n\nX: \`${Math.floor(p.x)}\`\nY: \`${Math.floor(p.y)}\`\nZ: \`${Math.floor(p.z)}\`\n\n❤️ ${s.bot.health?.toFixed(1)||'?'}/20\n🍗 ${s.bot.food||'?'}/20`,
              botMenuKeyboard(id)
            );
          }
          break;

        case 'st': {
          const players = s.isConnected && s.bot ? Object.keys(s.bot.players).length : 0;
          const sec2 = Math.floor((Date.now() - s.startTime) / 1000);
          const h2 = Math.floor(sec2/3600), m2 = Math.floor((sec2%3600)/60), s2 = sec2%60;
          send(chatId,
            `📊 *حالة \`${id}\`*\n\n🌐 \`${s.host}:${s.port}\`\n🔌 ${s.isConnected ? '🟢 متصل' : '🔴 غير متصل'}\n👥 اللاعبون: ${players}\n⏱️ ${h2}س ${m2}د ${s2}ث\n🔄 اتصالات: ${s.reconnectCount}`,
            botMenuKeyboard(id)
          );
          break;
        }

        case 'ch':
          if (!s.isConnected || !s.bot) {
            send(chatId, `❌ \`${id}\` غير متصل!`, botMenuKeyboard(id));
          } else {
            pendingAction.set(chatId, { type: 'chat', botId: id });
            send(chatId, `💬 *إرسال رسالة عبر \`${id}\`:*\nاكتب الرسالة الآن 👇`);
          }
          break;

        case 'sv':
          pendingAction.set(chatId, { type: 'server', botId: id });
          send(chatId,
            `🔧 *تغيير سيرفر \`${id}\`*\n\nالحالي: \`${s.host}:${s.port}\`\n\nأرسل السيرفر الجديد:\n\`IP:PORT\``
          );
          break;

        case 'ver':
          pendingAction.set(chatId, { type: 'version', botId: id });
          send(chatId,
            `🧩 *تغيير إصدار \`${id}\`*\n\n` +
            `الحالي: \`${s.version}\`\n\n` +
            `أرسل الإصدار الجديد:\n_مثال: \`1.20.2\`_`
          );
          break;

        case 'nm':
          pendingAction.set(chatId, { type: 'rename', botId: id });
          send(chatId,
            `✏️ *تغيير اسم \`${id}\`*\n\n` +
            `الاسم الحالي: \`${s.username}\`\n\n` +
            `أرسل الاسم الجديد:\n_ماكسيموم 16 حرف، بدون مسافات_`
          );
          break;

        case 'del':
          if (s) {
            stopBot(id);
            botsMap.delete(id);
            saveBotsConfig();
            log('warn', `تم حذف البوت ${id}`);
          }
          send(chatId, `🗑️ *تم حذف البوت \`${id}\`*`, mainMenuKeyboard());
          break;
      }
    }
  });

  // ── إشعار بدء التشغيل ─────────────────────────────────────
  notify(
    `🤖 *النظام يعمل!*\n\nعدد البوتات: ${botsMap.size}\n📅 ${new Date().toLocaleString('ar-MA')}\n\n/start للقائمة`,
    mainMenuKeyboard()
  );
}

// ═══════════════════════════════════════════════════════════════
//  تشغيل بوت
// ═══════════════════════════════════════════════════════════════
function startBot(id) {
  const s = botsMap.get(id);
  if (!s) return;
  clearBotTimers(s);
  s.isBotRunning = true;
  s.reconnectCount++;
  s.isRegistered = false; // Reset for auto-auth

  // ── اختيار الاسم: أول اتصال = الاسم الأصلي، إعادة اتصال = اسم جديد ──
  s.currentUsername = getNextUsername(s);
  if (s.reconnectCount > 1) {
    log('warn', `تغيير الاسم إلى: ${s.currentUsername}`, id);
    notify(`🎭 [*${id}*] اسم جديد: \`${s.currentUsername}\``);
  }
  log('info', `محاولة #${s.reconnectCount} (${s.currentUsername}) → ${s.host}:${s.port}`, id);

  try {
    s.bot = mineflayer.createBot({
      host:     s.host,
      port:     s.port,
      username: s.currentUsername,
      auth:     config.bot.auth,
      version:  s.version,
      hideErrors: false,
      viewDistance: 'tiny', // تقليل اللاق بمنع تحميل قطع كثيرة
    });
  } catch (err) {
    log('error', `فشل: ${err.message}`, id);
    if (s.isBotRunning) scheduleReconnect(id);
    return;
  }

  s.bot.loadPlugin(pathfinder);
  s.bot.once('spawn',      () => onSpawn(id));
  s.bot.on('chat',         (u, m) => onChat(id, u, m));
  s.bot.on('whisper',      (u, m) => onWhisper(id, u, m));
  s.bot.on('message',      (m, p) => onMessage(id, m, p));
  s.bot.on('kicked',       (r) => onKicked(id, r));
  s.bot.on('error',        (e) => onError(id, e));
  s.bot.on('end',          (r) => onEnd(id, r));
  s.bot.on('death',        () => onDeath(id));
  s.bot.on('health',       () => onHealth(id));
  s.bot.on('playerJoined', (p) => onPlayerJoined(id, p));
  s.bot.on('playerLeft',   (p) => onPlayerLeft(id, p));
}

// ═══════════════════════════════════════════════════════════════
//  إيقاف بوت
// ═══════════════════════════════════════════════════════════════
function stopBot(id) {
  const s = botsMap.get(id);
  if (!s) return;
  s.isBotRunning = false;
  clearBotTimers(s);
  s.isConnected = false;
}

function clearBotTimers(s) {
  if (s.wanderTimer)    { clearInterval(s.wanderTimer);   s.wanderTimer    = null; }
  if (s.reconnectTimer) { clearTimeout(s.reconnectTimer); s.reconnectTimer = null; }
  if (s.stuckTimer)     { clearInterval(s.stuckTimer);    s.stuckTimer     = null; }
  if (s.bot) {
    try { s.bot.removeAllListeners(); s.bot.quit(); } catch (_) {}
    s.bot = null;
  }
}

function scheduleReconnect(id) {
  const s = botsMap.get(id);
  if (!s) return;
  clearBotTimers(s);
  s.reconnectTimer = setTimeout(() => startBot(id), config.settings.reconnectDelay);
  log('info', `إعادة الاتصال خلال ${config.settings.reconnectDelay/1000}s...`, id);
}

// ═══════════════════════════════════════════════════════════════
//  أحداث ماين كرافت
// ═══════════════════════════════════════════════════════════════
function onSpawn(id) {
  const s = botsMap.get(id);
  if (!s) return;
  s.isConnected = true;
  const pos = s.bot.entity.position;
  log('success', `دخل السيرفر! (${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)})`, id);

  const mcData = require('minecraft-data')(s.bot.version);
  const mv = new Movements(s.bot, mcData);
  mv.allowSprinting = true;
  mv.allowParkour   = false;
  mv.canDig         = false;
  s.bot.pathfinder.setMovements(mv);

  // حفظ نقطة البداية للتجول المتراكم
  s.wanderOrigin = { x: pos.x, z: pos.z };
  s.lastPos = { x: pos.x, z: pos.z };

  // ── عند الوصول للهدف: ابدأ هدفاً جديداً فوراً ────────────
  s.bot.on('goal_reached', () => {
    if (s.isConnected && s.bot) {
      log('bot', 'وصل الهدف ← هدف جديد فوراً', id);
      doWander(id);
    }
  });

  // ── كشف التعثّر: إذا لم يتحرك البوت 5 ثوانٍ → هدف جديد ─
  s.stuckTimer = setInterval(() => {
    if (!s.isConnected || !s.bot || !s.bot.entity) return;
    const cur = s.bot.entity.position;
    const last = s.lastPos;
    if (last) {
      const dx = Math.abs(cur.x - last.x);
      const dz = Math.abs(cur.z - last.z);
      if (dx < 0.5 && dz < 0.5) {
        log('warn', 'البوت عالق! ← هدف جديد', id);
        doWander(id);
      }
    }
    s.lastPos = { x: cur.x, z: cur.z };
  }, 5000);

  // ── بدء التجول فوراً ─────────────────────────────────────
  doWander(id);

  notify(
    `✅ *\`${id}\` دخل السيرفر!*\n\n🌐 \`${s.host}:${s.port}\`\n📍 (${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)})\n👥 ${Object.keys(s.bot.players).length} لاعب`,
    botMenuKeyboard(id)
  );
  setTimeout(() => { try { s.bot.chat('مرحبا!'); } catch (_) {} }, 3000);
}

function onChat(id, username, message) {
  const s = botsMap.get(id);
  if (!s || !s.bot || username === s.bot.username) return;
  log('info', `[عام] ${username}: ${message}`, id);
  if (config.telegram.forwardChat) {
    notify(`💬 [*${id}*] *${username}*: ${message}`);
  }
}

function onMessage(id, jsonMsg, position) {
  const s = botsMap.get(id);
  if (!s || !s.bot) return;

  const msg = jsonMsg.toString();
  const lowerMsg = msg.toLowerCase();

  // طباعة رسائل السيرفر لفهم ما يطلبه
  if (position === 'system' || !msg.includes('<')) {
    log('info', `[سيرفر] ${msg}`, id);
  }

  // كشف طلب تسجيل الدخول
  if ((lowerMsg.includes('/login') || lowerMsg.includes('login') || lowerMsg.includes('تسجيل الدخول')) && !s.isRegistered) {
    log('warn', 'يُطلب تسجيل الدخول... جاري المحاولة', id);
    setTimeout(() => {
      if (s.bot) s.bot.chat(`/login ${s.password}`);
    }, 1500);
    s.isRegistered = true;
  } 
  // كشف طلب التسجيل الجديد
  else if ((lowerMsg.includes('/register') || lowerMsg.includes('register') || lowerMsg.includes('تسجيل حساب')) && !s.isRegistered) {
    log('warn', 'يُطلب تسجيل حساب... جاري الإنشاء', id);
    setTimeout(() => {
      if (s.bot) s.bot.chat(`/register ${s.password} ${s.password}`);
    }, 1500);
    s.isRegistered = true;
  }
}

function onWhisper(id, username, message) {
  log('warn', `[خاص] ${username}: ${message}`, id);
  if (!tg || !config.telegram.chatId) return;
  tg.sendMessage(config.telegram.chatId,
    `📩 [*${id}*] رسالة خاصة من \`${username}\`:\n\n"${message}"`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [[
          { text: `↩️ رد على ${username}`, callback_data: `wr:${id}:${username}` },
        ]],
      },
    }
  ).catch(() => {});
}

function onKicked(id, reason) {
  const s = botsMap.get(id);
  if (!s) return;
  s.isConnected = false;
  let r = reason;
  try { r = JSON.parse(reason).text || reason; } catch (_) {}
  log('warn', `طُرد! السبب: ${r}`, id);
  notify(`⚠️ *\`${id}\` طُرد من السيرفر!*\nالسبب: ${r}`, botMenuKeyboard(id));
  if (s.isBotRunning) scheduleReconnect(id);
}

function onError(id, err) {
  const s = botsMap.get(id);
  if (s) s.isConnected = false;
  log('error', `خطأ: ${err.message || err}`, id);
}

function onEnd(id, reason) {
  const s = botsMap.get(id);
  if (!s) return;
  s.isConnected = false;
  log('warn', `انتهى: ${reason || 'غير معروف'}`, id);
  if (s.isBotRunning) scheduleReconnect(id);
}

function onDeath(id) {
  log('warn', 'مات! إحياء تلقائي...', id);
  const s = botsMap.get(id);
  if (s && s.bot) setTimeout(() => { try { s.bot.respawn(); } catch (_) {} }, 1500);
}

function onHealth(id) {
  const s = botsMap.get(id);
  if (s && s.bot && s.bot.health < 5) {
    log('warn', `صحة منخفضة: ${s.bot.health.toFixed(1)}`, id);
  }
}

function onPlayerJoined(id, player) {
  const s = botsMap.get(id);
  if (!s || !s.bot || player.username === s.bot.username) return;
  log('info', `دخل: ${player.username}`, id);
}

function onPlayerLeft(id, player) {
  const s = botsMap.get(id);
  if (!s || !s.bot || player.username === s.bot.username) return;
  log('info', `غادر: ${player.username}`, id);
}

// ═══════════════════════════════════════════════════════════════
//  التجول
// ═══════════════════════════════════════════════════════════════
function doWander(id) {
  const s = botsMap.get(id);
  if (!s || !s.bot || !s.bot.entity || !s.isConnected) return;

  // منع الاستدعاءات المتكررة أسرع من 4 ثواني لتقليل اللاق
  const now = Date.now();
  if (now - s.lastWanderTime < 4000) return;
  s.lastWanderTime = now;

  const pos = s.bot.entity.position;

  // نطاق تجول أكبر لضمان الحركة المستمرة (50 بلوك)
  const r  = Math.max(config.settings.wanderRadius, 50);

  // تجول متراكم: البوت يبتعد تدريجياً ثم يعود
  let tx, tz;
  if (s.wanderOrigin) {
    // 70% ابتعاد عشوائي، 30% عودة نحو المنشأ لتجنّب الابتعاد الكبير
    if (Math.random() < 0.3) {
      // عودة نحو نقطة البداية
      tx = s.wanderOrigin.x + (Math.random() * 20 - 10);
      tz = s.wanderOrigin.z + (Math.random() * 20 - 10);
    } else {
      tx = pos.x + (Math.random() * r * 2 - r);
      tz = pos.z + (Math.random() * r * 2 - r);
    }
  } else {
    tx = pos.x + (Math.random() * r * 2 - r);
    tz = pos.z + (Math.random() * r * 2 - r);
  }

  log('bot', `← (${Math.floor(tx)}, ?, ${Math.floor(tz)})`, id);
  try {
    s.bot.pathfinder.setGoal(new GoalNear(tx, pos.y, tz, 1), true);
  } catch (e) {
    log('warn', `تجول: ${e.message}`, id);
    // محاولة بهدف أقرب عند الخطأ
    try {
      const fallbackR = 10;
      s.bot.pathfinder.setGoal(
        new GoalNear(
          pos.x + (Math.random() * fallbackR * 2 - fallbackR),
          pos.y,
          pos.z + (Math.random() * fallbackR * 2 - fallbackR),
          1
        ), true
      );
    } catch (_) {}
  }
}

// ═══════════════════════════════════════════════════════════════
//  إشارات النظام
// ═══════════════════════════════════════════════════════════════
process.on('SIGINT', () => {
  log('warn', 'إيقاف...');
  notify('🔴 *النظام أُوقف يدوياً.*');
  for (const id of botsMap.keys()) stopBot(id);
  process.exit(0);
});
process.on('uncaughtException', (err) => {
  log('error', `استثناء: ${err.message}`);
});
process.on('unhandledRejection', (r) => {
  log('error', `رفض: ${r}`);
});

// ═══════════════════════════════════════════════════════════════
//  البدء
// ═══════════════════════════════════════════════════════════════
console.log(`
${C.bold}${C.blue}
╔══════════════════════════════════════════════════╗
║  🤖  Minecraft Multi-Bot + Telegram Manager 🤖  ║
║      إدارة بوتات متعددة عبر تيليجرام            ║
╚══════════════════════════════════════════════════╝
${C.reset}`);

// تحميل البوتات المحفوظة
const savedBots = loadBotsConfig();
for (const b of savedBots) {
  const id    = b.id || newBotId();
  const state = createBotState(id, b.host, b.port, b.username || 'BotPlayer', b.version || '1.20.1');
  botsMap.set(id, state);
  // تحديث العداد لتجنب تكرار IDs
  const num = parseInt(id.slice(1));
  if (!isNaN(num) && num >= botCounter) botCounter = num;
}

log('info', `تم تحميل ${botsMap.size} بوت من الملف`);
log('tg', `تيليجرام: ${config.telegram.token !== 'YOUR_TELEGRAM_BOT_TOKEN' ? C.green+'مفعّل ✅' : C.yellow+'غير مضبوط ⚠️'}${C.reset}`);
console.log('');

// تشغيل تيليجرام
initTelegram();

// تشغيل كل البوتات المحفوظة
for (const id of botsMap.keys()) {
  log('info', `تشغيل ${id}...`);
  startBot(id);
}
