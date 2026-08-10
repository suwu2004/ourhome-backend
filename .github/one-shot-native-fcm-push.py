from pathlib import Path
import json
import re

server_path = Path('server.js')
server = server_path.read_text()

require_anchor = "const webpush = require('web-push');\nconst { createRuntimeConfig } = require('./runtimeConfig');"
require_replacement = "const webpush = require('web-push');\nconst { createNativePushSender } = require('./nativePush');\nconst { createRuntimeConfig } = require('./runtimeConfig');"
if "require('./nativePush')" not in server:
    if require_anchor not in server:
        raise SystemExit('native push require anchor missing')
    server = server.replace(require_anchor, require_replacement, 1)

sender_anchor = """const agentMailService = createAgentMailService({
  runtimeConfig,
  auditStore: agentMailAuditStore,
  reviewOutgoing: reviewAgentMailOutgoing,
});
const weatherCache = new Map();
"""
sender_replacement = """const agentMailService = createAgentMailService({
  runtimeConfig,
  auditStore: agentMailAuditStore,
  reviewOutgoing: reviewAgentMailOutgoing,
});
const nativePush = createNativePushSender();
if (nativePush.configured) console.log(`FCM 原生推送已配置，topic: ${nativePush.topic}`);
const weatherCache = new Map();
"""
if 'const nativePush = createNativePushSender();' not in server:
    if sender_anchor not in server:
        raise SystemExit('native push sender anchor missing')
    server = server.replace(sender_anchor, sender_replacement, 1)

pattern = re.compile(r"async function sendPushToAll\(title, body, data = \{\}\) \{.*?\n\}\n\nasync function dailyAutomationModel", re.S)
replacement = """async function sendPushToAll(title, body, data = {}) {
  let configured = false;
  let sent = 0;
  let failed = 0;

  if (PUSH_CONFIGURED) {
    configured = true;
    try {
      const { data: subs, error: subscriptionsError } = await supabase.from('push_subscriptions').select('*');
      if (subscriptionsError) throw subscriptionsError;
      const payload = JSON.stringify({ title, body, data });
      for (const sub of subs || []) {
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
    } catch (error) {
      failed++;
      console.error('Web Push 批量发送失败:', error.message);
    }
  }

  try {
    const nativeResult = await nativePush.send(title, body, data);
    configured = configured || Boolean(nativeResult.configured);
    sent += Number(nativeResult.sent || 0);
    failed += Number(nativeResult.failed || 0);
  } catch (error) {
    if (nativePush.configured) {
      configured = true;
      failed++;
    }
    console.error('FCM 原生推送失败:', error.message);
  }

  return { configured, sent, failed, nativeConfigured: nativePush.configured };
}

async function dailyAutomationModel"""
if 'nativeConfigured: nativePush.configured' not in server:
    server, count = pattern.subn(replacement, server, count=1)
    if count != 1:
        raise SystemExit('sendPushToAll anchor missing')

server_path.write_text(server)

package_path = Path('package.json')
package = json.loads(package_path.read_text())
check = package['scripts']['check']
if 'node --check nativePush.js' not in check:
    anchor = 'node --check server.js'
    if anchor not in check:
        raise SystemExit('package check anchor missing')
    check = check.replace(anchor, 'node --check nativePush.js && ' + anchor, 1)
    package['scripts']['check'] = check
    package_path.write_text(json.dumps(package, ensure_ascii=False, indent=2) + '\n')
