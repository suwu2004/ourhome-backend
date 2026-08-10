from pathlib import Path
import re

path = Path('server.js')
text = path.read_text()
text = text.replace(
    "if (nativePush.configured) console.log(`FCM 原生推送已配置，topic: ${nativePush.topic}`);",
    "if (nativePush.configured) console.log('FCM 原生推送服务端已配置');",
)

send_pattern = re.compile(r"async function sendPushToAll\(title, body, data = \{\}\) \{.*?\n\}\n\nasync function dailyAutomationModel", re.S)
send_replacement = """async function sendPushToAll(title, body, data = {}) {
  const anyConfigured = PUSH_CONFIGURED || nativePush.configured;
  if (!anyConfigured) return { configured: false, sent: 0, failed: 0, nativeConfigured: false };

  let sent = 0;
  let failed = 0;
  let subs = [];
  try {
    const result = await supabase.from('push_subscriptions').select('*');
    if (result.error) throw result.error;
    subs = result.data || [];
  } catch (error) {
    console.error('推送订阅读取失败:', error.message);
    return { configured: true, sent: 0, failed: 1, nativeConfigured: nativePush.configured };
  }

  const webSubs = subs.filter(sub => !String(sub.endpoint || '').startsWith('fcm:'));
  const nativeSubs = subs.filter(sub => String(sub.endpoint || '').startsWith('fcm:'));

  if (PUSH_CONFIGURED) {
    const payload = JSON.stringify({ title, body, data });
    for (const sub of webSubs) {
      try {
        await webpush.sendNotification({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } }, payload);
        sent++;
      } catch (pushErr) {
        failed++;
        if (pushErr.statusCode === 410 || pushErr.statusCode === 404) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        } else {
          console.error('Web Push 失败:', pushErr.message);
        }
      }
    }
  }

  if (nativePush.configured) {
    for (const sub of nativeSubs) {
      const endpoint = String(sub.endpoint || '');
      const token = endpoint.startsWith('fcm:') ? endpoint.slice(4) : '';
      if (!token) continue;
      try {
        const nativeResult = await nativePush.sendToToken(token, title, body, data);
        sent += Number(nativeResult.sent || 0);
        failed += Number(nativeResult.failed || 0);
      } catch (error) {
        failed++;
        const stale = error.status === 404 || /UNREGISTERED|NOT_FOUND/i.test(`${error.code || ''} ${error.message || ''}`);
        if (stale) {
          await supabase.from('push_subscriptions').delete().eq('id', sub.id);
        } else {
          console.error('FCM 原生推送失败:', error.message);
        }
      }
    }
  }

  return { configured: true, sent, failed, nativeConfigured: nativePush.configured };
}

async function dailyAutomationModel"""
text, count = send_pattern.subn(send_replacement, text, count=1)
if count != 1:
    raise SystemExit('sendPushToAll replacement failed')

if "app.post('/push/native/register'" not in text:
    subscribe_match = re.search(r"app\.post\('/push/subscribe', async \(req, res\) => \{.*?\n\}\);", text, re.S)
    if not subscribe_match:
        raise SystemExit('push subscribe route anchor missing')
    native_routes = """

app.post('/push/native/register', async (req, res) => {
  if (!nativePush.configured) return res.status(503).json({ error: '服务器还没有配置 Firebase 原生推送' });
  const token = String(req.body?.token || '').trim();
  if (!token || token.length > 4096 || /\\s/.test(token)) return res.status(400).json({ error: 'FCM 设备 token 不合法' });
  const endpoint = `fcm:${token}`;
  const { error } = await supabase.from('push_subscriptions')
    .upsert({ endpoint, p256dh: 'fcm', auth: 'fcm' }, { onConflict: 'endpoint' });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, native: true });
});

app.delete('/push/native/register', async (req, res) => {
  const token = String(req.body?.token || '').trim();
  if (!token) return res.status(400).json({ error: '缺少 FCM 设备 token' });
  const endpoint = `fcm:${token}`;
  const { error } = await supabase.from('push_subscriptions').delete().eq('endpoint', endpoint);
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true });
});
"""
    insert_at = subscribe_match.end()
    text = text[:insert_at] + native_routes + text[insert_at:]

path.write_text(text)
