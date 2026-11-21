export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') {
      return new Response('OK', { status: 200 });
    }

    const secretToken = request.headers.get(
      'X-Telegram-Bot-Api-Secret-Token'
    );

    if (secretToken !== env.WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      const update = await request.json();

      if (update.message) {
        ctx.waitUntil(
          processUpdate(update.message, env).catch(async error => {
            console.error('FATAL:', error);
            const chatId = update.message?.chat?.id;

            if (chatId) {
              await logEvent(
                env,
                chatId,
                'ERROR',
                'UNHANDLED_ERROR',
                error.stack || error.message || String(error),
                true
              );
            }
          })
        );
      }

      return new Response('OK', { status: 200 });

    } catch (error) {
      console.error('WEBHOOK ERROR:', error);
      return new Response('Error', { status: 500 });
    }
  }
};


// ===============================
// DATABASE
// ===============================

async function initializeDatabase(env) {
  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT DEFAULT '',
      first_name TEXT DEFAULT ''
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      message_type TEXT,
      content TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  await env.DB.prepare(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      level TEXT,
      event TEXT,
      details TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `).run();

  // سازگاری با جدول logs قدیمی
  try {
    await env.DB.prepare(
      `ALTER TABLE logs ADD COLUMN chat_id INTEGER`
    ).run();
  } catch (e) {
    // ستون از قبل وجود دارد
  }
}


// ===============================
// LOGGING
// ===============================

async function logEvent(env, chatId, level, event, details, live = true) {
  const message = String(details || '').slice(0, 3000);

  try {
    await env.DB.prepare(`
      INSERT INTO logs (chat_id, level, event, details)
      VALUES (?, ?, ?, ?)
    `).bind(
      chatId || 0,
      level,
      event,
      message
    ).run();
  } catch (error) {
    console.error('LOG DATABASE ERROR:', error);
  }

  console.log(`[${level}] ${event}: ${message}`);

  // نمایش زنده لاگ در تلگرام
  if (live && chatId) {
    const emoji = level === 'ERROR' ? '🔴' :
                  level === 'WARN' ? '🟠' : '🟢';

    await sendTelegram(env, 'sendMessage', {
      chat_id: chatId,
      text: `${emoji} ${level}\n${event}\n${message.slice(0, 2500)}`
    }).catch(error => {
      console.error('LIVE LOG ERROR:', error);
    });
  }
}


// ===============================
// MAIN PROCESS
// ===============================

async function processUpdate(message, env) {
  const chatId = message.chat.id;
  const userId = message.from?.id || chatId;
  const text = message.text || '';
  const userName = message.from?.first_name || 'کاربر';

  try {
    await initializeDatabase(env);

    await logEvent(
      env,
      chatId,
      'INFO',
      'NEW_MESSAGE',
      `User: ${userName} | Chat: ${chatId}`
    );

    // ثبت کاربر
    await env.DB.prepare(`
      INSERT INTO users (id, username, first_name)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).bind(
      userId,
      message.from?.username || '',
      userName
    ).run();


    // ===============================
    // START
    // ===============================

    if (text.startsWith('/start')) {
      const config = await loadConfig(env);

      const welcome = (config.bot_settings?.welcome_message || 'سلام {name}!')
        .replace('{name}', userName);

      await sendTelegram(env, 'sendMessage', {
        chat_id: chatId,
        text: welcome
      });

      return;
    }


    // ===============================
    // HELP
    // ===============================

    if (text.startsWith('/help')) {
      const config = await loadConfig(env);

      await sendTelegram(env, 'sendMessage', {
        chat_id: chatId,
        text: config.bot_settings?.help_message || 'برای شروع پیام خود را ارسال کنید.'
      });

      return;
    }


    // ===============================
    // LOG FILE
    // ===============================

    if (text.trim() === '/logfile') {
      await sendLogFile(env, chatId);
      return;
    }


    // ===============================
    // LOAD CONFIG
    // ===============================

    const config = await loadConfig(env);

    if (!config.ai_settings) {
      throw new Error('ai_settings در config.json وجود ندارد.');
    }

    if (!config.ai_settings.system_prompt) {
      throw new Error('system_prompt در config.json تنظیم نشده است.');
    }

    if (!config.ai_settings.provider_url) {
      throw new Error('provider_url در config.json تنظیم نشده است.');
    }

    await logEvent(
      env,
      chatId,
      'INFO',
      'CONFIG_LOADED',
      'تنظیمات با موفقیت دریافت شد.'
    );


    // ===============================
    // PREPARE AI MESSAGES
    // ===============================

    const aiMessages = [
      {
        role: 'system',
        content: config.ai_settings.system_prompt
      }
    ];

    let msgType = 'text';
    let contentLog = text;

    const photo = message.photo;
    const document = message.document;


    // ===============================
    // PHOTO
    // ===============================

    if (photo && photo.length) {
      msgType = 'photo';

      await logEvent(
        env,
        chatId,
        'INFO',
        'PHOTO_RECEIVED',
        'در حال دریافت تصویر از تلگرام...'
      );

      const fileId = photo[photo.length - 1].file_id;

      const filePath = await getFilePath(env, fileId);

      const fileUrl =
        `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;

      const imageResponse = await fetch(fileUrl);

      if (!imageResponse.ok) {
        throw new Error('دریافت تصویر از تلگرام ناموفق بود.');
      }

      const imageBuffer = await imageResponse.arrayBuffer();

      if (imageBuffer.byteLength > 5 * 1024 * 1024) {
        throw new Error('حجم تصویر بیشتر از ۵ مگابایت است.');
      }

      const base64 = arrayBufferToBase64(imageBuffer);

      aiMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: text || 'این تصویر را تحلیل کن.'
          },
          {
            type: 'image_url',
            image_url: {
              url: `data:image/jpeg;base64,${base64}`
            }
          }
        ]
      });

      contentLog = '[Photo]';
    }


    // ===============================
    // DOCUMENT
    // ===============================

    else if (document) {
      msgType = 'document';

      const fileName = document.file_name || 'بدون نام';
      const fileSize = document.file_size || 0;
      const mimeType = document.mime_type || 'نامشخص';

      aiMessages.push({
        role: 'user',
        content:
          `کاربر یک فایل ارسال کرده است.\n` +
          `نام فایل: ${fileName}\n` +
          `نوع فایل: ${mimeType}\n` +
          `حجم فایل: ${fileSize} بایت\n` +
          `توضیحات کاربر: ${text || 'بدون توضیح'}\n` +
          `محتوای فایل هنوز استخراج نشده است.`
      });

      contentLog = `[Document: ${fileName}]`;
    }


    // ===============================
    // TEXT
    // ===============================

    else if (text) {
      aiMessages.push({
        role: 'user',
        content: text
      });
    }

    else {
      await logEvent(
        env,
        chatId,
        'WARN',
        'UNSUPPORTED_MESSAGE',
        'نوع پیام پشتیبانی نمی‌شود.'
      );

      return;
    }


    // ===============================
    // SAVE MESSAGE
    // ===============================

    await env.DB.prepare(`
      INSERT INTO messages (user_id, message_type, content)
      VALUES (?, ?, ?)
    `).bind(
      userId,
      msgType,
      contentLog
    ).run();


    // ===============================
    // TYPING
    // ===============================

    await sendTelegram(env, 'sendChatAction', {
      chat_id: chatId,
      action: 'typing'
    });


    // ===============================
    // CALL AVALAI
    // ===============================

    await logEvent(
      env,
      chatId,
      'INFO',
      'AI_REQUEST',
      `درخواست به مدل ${config.ai_settings.model} ارسال شد.`
    );

    const controller = new AbortController();

    const timeout = setTimeout(() => {
      controller.abort();
    }, 90000);

    let aiResponse;

    try {
      aiResponse = await fetch(config.ai_settings.provider_url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${env.AVALAI_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: config.ai_settings.model,
          messages: aiMessages,
          max_tokens: config.ai_settings.max_tokens || 2000,
          temperature: config.ai_settings.temperature ?? 0.7
        }),
        signal: controller.signal
      });
    } finally {
      clearTimeout(timeout);
    }


    // ===============================
    // CHECK AI RESPONSE
    // ===============================

    if (!aiResponse.ok) {
      const errorText = await aiResponse.text();

      throw new Error(
        `AvalAI HTTP ${aiResponse.status}: ${errorText.slice(0, 1500)}`
      );
    }

    const aiData = await aiResponse.json();

    if (!aiData.choices || !aiData.choices.length) {
      throw new Error(
        'پاسخ مدل معتبر نیست: choices دریافت نشد.'
      );
    }

    const answer = aiData.choices[0].message?.content;

    if (!answer) {
      throw new Error('متن پاسخ هوش مصنوعی خالی است.');
    }


    // ===============================
    // SEND ANSWER
    // ===============================

    await logEvent(
      env,
      chatId,
      'INFO',
      'AI_RESPONSE_RECEIVED',
      'پاسخ هوش مصنوعی دریافت شد.'
    );

    await sendLongMessage(env, chatId, answer);


    // ===============================
    // SAVE AI RESPONSE
    // ===============================

    await env.DB.prepare(`
      INSERT INTO messages (user_id, message_type, content)
      VALUES (?, ?, ?)
    `).bind(
      userId,
      'assistant',
      answer.slice(0, 10000)
    ).run();


    await logEvent(
      env,
      chatId,
      'INFO',
      'PROCESS_COMPLETED',
      'پردازش پیام با موفقیت انجام شد.'
    );

  } catch (error) {

    await logEvent(
      env,
      chatId,
      'ERROR',
      'PROCESS_ERROR',
      error.stack || error.message || String(error)
    );

    await sendTelegram(env, 'sendMessage', {
      chat_id: chatId,
      text: '⚠️ متأسفانه خطایی رخ داد. جزئیات خطا در لاگ ثبت شده است.'
    }).catch(e => console.error(e));
  }
}


// ===============================
// CONFIG
// ===============================

async function loadConfig(env) {
  const configUrl = env.CONFIG_URL ||
    'https://raw.githubusercontent.com/shiraziai-1405/ai-1/main/config.json';

  const response = await fetch(configUrl, {
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    throw new Error(`Config HTTP Error: ${response.status}`);
  }

  return await response.json();
}


// ===============================
// TELEGRAM API
// ===============================

async function sendTelegram(env, method, body) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(body)
    }
  );

  const data = await response.json();

  if (!response.ok || !data.ok) {
    throw new Error(
      `Telegram API Error: ${JSON.stringify(data).slice(0, 1000)}`
    );
  }

  return data;
}


// ===============================
// LONG MESSAGE SPLITTER
// ===============================

async function sendLongMessage(env, chatId, text) {
  const maxLength = 4000;

  for (let i = 0; i < text.length; i += maxLength) {
    await sendTelegram(env, 'sendMessage', {
      chat_id: chatId,
      text: text.slice(i, i + maxLength)
    });
  }
}


// ===============================
// GET TELEGRAM FILE
// ===============================

async function getFilePath(env, fileId) {
  const response = await fetch(
    `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${encodeURIComponent(fileId)}`
  );

  const data = await response.json();

  if (!response.ok || !data.ok || !data.result?.file_path) {
    throw new Error('دریافت مسیر فایل از تلگرام ناموفق بود.');
  }

  return data.result.file_path;
}


// ===============================
// ARRAY BUFFER TO BASE64
// ===============================

function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  let binary = '';

  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(
      ...bytes.subarray(i, i + chunkSize)
    );
  }

  return btoa(binary);
}


// ===============================
// DOWNLOAD LOG FILE
// ===============================

async function sendLogFile(env, chatId) {
  try {
    const result = await env.DB.prepare(`
      SELECT level, event, details, created_at
      FROM logs
      WHERE chat_id = ?
      ORDER BY id DESC
      LIMIT 200
    `).bind(chatId).all();

    const rows = result.results || [];

    let content = 'TELEGRAM BOT LOGS\n';
    content += '==============================\n\n';

    for (const row of rows.reverse()) {
      content += `[${row.created_at}] ${row.level}\n`;
      content += `${row.event}\n`;
      content += `${row.details}\n`;
      content += '------------------------------\n';
    }

    if (!rows.length) {
      content += 'No logs found.\n';
    }

    const file = new Blob(
      [content],
      { type: 'text/plain; charset=utf-8' }
    );

    const form = new FormData();

    form.append('chat_id', String(chatId));
    form.append('document', file, 'bot-logs.txt');
    form.append('caption', '📄 گزارش لاگ ربات');

    const response = await fetch(
      `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendDocument`,
      {
        method: 'POST',
        body: form
      }
    );

    const data = await response.json();

    if (!response.ok || !data.ok) {
      throw new Error(JSON.stringify(data));
    }

  } catch (error) {
    console.error('LOG FILE ERROR:', error);

    await sendTelegram(env, 'sendMessage', {
      chat_id: chatId,
      text: '❌ دریافت فایل لاگ ناموفق بود: ' + error.message
    });
  }
}

// END
