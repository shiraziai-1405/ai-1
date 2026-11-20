export default {
  async fetch(request, env, ctx) {
    if (request.method !== 'POST') return new Response('OK', { status: 200 });

    const secretToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (secretToken !== env.WEBHOOK_SECRET) {
      return new Response('Unauthorized', { status: 401 });
    }

    try {
      const update = await request.json();
      const configRes = await fetch(env.CONFIG_URL || 'https://raw.githubusercontent.com/shiraziai-1405/ai-1/main/config.json');
      const config = await configRes.json();

      if (update.message) {
        ctx.waitUntil(handleMessage(update.message, env, config));
      }
      return new Response('OK', { status: 200 });
    } catch (e) {
      console.error(e);
      return new Response('Error', { status: 500 });
    }
  }
};

async function handleMessage(message, env, config) {
  const chatId = message.chat.id;
  const text = message.text || '';
  const photo = message.photo;
  const document = message.document;
  const userName = message.from.first_name || 'کاربر';

  await env.DB.prepare(
    `INSERT INTO users (id, username, first_name) VALUES (?, ?, ?) ON CONFLICT(id) DO NOTHING`
  ).bind(chatId, message.from.username || '', userName).run();

  if (text.startsWith('/start')) {
    const welcome = config.bot_settings.welcome_message.replace('{name}', userName);
    return sendTelegram(env, 'sendMessage', { chat_id: chatId, text: welcome });
  }

  if (text.startsWith('/help')) {
    return sendTelegram(env, 'sendMessage', { chat_id: chatId, text: config.bot_settings.help_message });
  }

  let aiMessages = [{ role: "system", content: config.ai_settings.system_prompt }];
  let msgType = 'text';
  let contentLog = text;

  if (photo) {
    msgType = 'photo';
    const fileId = photo[photo.length - 1].file_id;
    const filePath = await getFilePath(env, fileId);
    const imageUrl = `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${filePath}`;
    aiMessages.push({
      role: "user",
      content: [
        { type: "text", text: text || "این عکس را تحلیل کن." },
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    });
    contentLog = "[Photo]";
  } else if (document && text) {
    msgType = 'document';
    aiMessages.push({ role: "user", content: `فایل با کپشن: ${text}` });
  } else if (text) {
    aiMessages.push({ role: "user", content: text });
  } else { return; }

  await env.DB.prepare(`INSERT INTO messages (user_id, message_type, content) VALUES (?, ?, ?)`).bind(chatId, msgType, contentLog).run();
  await sendTelegram(env, 'sendChatAction', { chat_id: chatId, action: 'typing' });

  const aiResponse = await fetch(config.ai_settings.provider_url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${env.AVALAI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: config.ai_settings.model,
      messages: aiMessages,
      max_tokens: config.ai_settings.max_tokens,
      temperature: config.ai_settings.temperature
    })
  });

  const aiData = await aiResponse.json();
  if (aiData.choices && aiData.choices.length > 0) {
    await sendTelegram(env, 'sendMessage', { chat_id: chatId, text: aiData.choices[0].message.content });
  } else {
    await sendTelegram(env, 'sendMessage', { chat_id: chatId, text: "متأسفانه خطایی رخ داد." });
  }
}

async function sendTelegram(env, method, body) {
  return fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
}

async function getFilePath(env, fileId) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json();
  return data.result.file_path;
}
