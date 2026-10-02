const crypto = require('crypto');
const dns = require('dns');

const PRESET_MESSAGES = [
  '今天北京天气怎么样？（请用一句话回答）',
  '给我讲一个冷笑话。（简短回答）',
  '来一首唐诗。（简短回答）',
  '空腹可以吃饭吗？（幽默简短回答）',
  '推荐一部经典的科幻电影。（简明扼要）',
  '人工智能未来发展趋势是什么？（简明扼要）',
  '怎样保持良好的身心健康？（简短回答）',
  '请用一句话分享今天的正能量心情。'
];

function md5(t) {
  return crypto.createHash('md5').update(t).digest('hex').toLowerCase();
}

function sha256(t) {
  return crypto.createHash('sha256').update(t).digest('hex').toLowerCase();
}

/**
 * 诊断埋点：完整还原网络异常的真实成因链。
 * 展开 err.cause 与 aggregateErrors，避免所有故障塌缩成无信息的统一报错。
 */
function describeNetError(err) {
  if (!err) return 'unknown';
  const seen = new Set();
  const chain = [];
  let cur = err;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (seen.has(cur)) break;
    seen.add(cur);
    const bits = [];
    if (cur.name && cur.name !== 'Error') bits.push(cur.name);
    if (cur.code) bits.push(`code=${cur.code}`);
    if (cur.errno) bits.push(`errno=${cur.errno}`);
    if (cur.syscall) bits.push(`syscall=${cur.syscall}`);
    if (cur.hostname) bits.push(`host=${cur.hostname}`);
    if (cur.address) bits.push(`addr=${cur.address}${cur.port ? ':' + cur.port : ''}`);
    if (cur.message && cur.message !== err.message) bits.push(`msg=${String(cur.message).slice(0, 200)}`);
    chain.push(`[${depth}] ${bits.join(' ') || String(cur.message || 'unknown').slice(0, 200)}`);
    cur = cur.cause;
  }
  const agg = err.aggregateErrors || err.errors;
  if (Array.isArray(agg) && agg.length) {
    agg.slice(0, 4).forEach((sub, i) => {
      const bits = [];
      if (sub && sub.code) bits.push(`code=${sub.code}`);
      if (sub && sub.address) bits.push(`addr=${sub.address}${sub.port ? ':' + sub.port : ''}`);
      chain.push(`[agg${i}] ${bits.join(' ') || String((sub && sub.message) || 'unknown').slice(0, 160)}`);
    });
  }
  return chain.join(' → ');
}

/**
 * 诊断埋点：DNS 预解析
 */
async function diagDns(label, hostname, onLog = console.log, src = 'AIChat') {
  const started = Date.now();
  try {
    const addrs = await dns.promises.lookup(hostname, { all: true });
    const list = (addrs || []).map(a => `${a.address}(IPv${a.family})`).join(', ') || '空';
    onLog(src, `[网络诊断] ${label} DNS ${hostname} → ${list} (${Date.now() - started}ms)`, 'info');
    return addrs;
  } catch (err) {
    onLog(src, `[网络诊断] ${label} DNS 解析失败 ${hostname} ✗ ${err.message} | ${describeNetError(err)} (${Date.now() - started}ms)`, 'error');
    return null;
  }
}

/**
 * 诊断与超时双重包装的 fetch，防止网络挂起阻塞账号队列
 */
async function netFetch(label, url, options = {}, onLog = console.log, src = 'AIChat', timeoutMs = 45000) {
  const started = Date.now();
  const stallTimer = setInterval(() => {
    onLog(src, `[网络诊断] ${label} 已等待 ${Math.round((Date.now() - started) / 1000)}s 仍无响应 (超时上限 ${Math.round(timeoutMs / 1000)}s) | ${url}`, 'warning');
  }, 15000);

  let signal = options.signal;
  let abortReason = '';
  if (!signal && timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    try {
      signal = AbortSignal.timeout(timeoutMs);
      abortReason = `请求超过 ${Math.round(timeoutMs / 1000)} 秒未完成，已主动中断以免阻塞账号队列`;
    } catch (e) { signal = undefined; }
  }

  try {
    const res = await fetch(url, signal ? { ...options, signal } : options);
    clearInterval(stallTimer);
    onLog(src, `[网络诊断] ${label} ← HTTP ${res.status} (${Date.now() - started}ms)`, 'info');
    return res;
  } catch (err) {
    clearInterval(stallTimer);
    const isTimeout = err && (err.name === 'TimeoutError' || err.name === 'AbortError');
    const detail = describeNetError(err);
    if (isTimeout) {
      const e = new Error(`${label} ${abortReason || '请求超时'} | ${detail} | 耗时 ${Date.now() - started}ms`);
      e.__netDetail = detail;
      e.__timeout = true;
      onLog(src, `[网络诊断] ${label} ✗ 超时中断 | ${e.message}`, 'error');
      throw e;
    }
    onLog(src, `[网络诊断] ${label} ✗ ${err.message} | ${detail} | 耗时 ${Date.now() - started}ms | url=${url}`, 'error');
    try { err.__netDetail = detail; } catch (e) { /* ignore */ }
    throw err;
  }
}

/**
 * 纯原生 HTTP 协议直连执行天翼 AI 对话任务 (零 Chromium)
 */
async function executeNativeAiChat(client, acc, onLog = console.log) {
  const flowStartedAt = Date.now();
  onLog('AIChat', `正在获取 AI 对话安全网关与 SSO 公钥配置...`, 'info');
  
  // 1. 获取网关信息并解密 SSO 公钥
  await diagDns('网关配置', 'gwyilian.ctyun.cn', onLog);
  const sysRes = await netFetch('[1/4] 获取网关配置 eaiSysInfo', 'https://gwyilian.ctyun.cn/server/eaiSysInfo', {}, onLog);
  const sysJson = await sysRes.json();
  const rawSys = (sysJson.data || '').replace(/[\r\n]/g, '');
  const decipher = crypto.createDecipheriv('aes-128-ecb', Buffer.from('chinatelecom@cnn', 'utf8'), null);
  let dec = decipher.update(rawSys, 'base64', 'utf8');
  dec += decipher.final('utf8');
  const gatewayInfo = JSON.parse(dec);
  const ssopk = gatewayInfo.sso?.ssopk;
  const ssopkid = gatewayInfo.sso?.ssopkid;

  if (!ssopk) {
    throw new Error('未能从网关提取到有效的 SSO RSA 公钥配置');
  }

  // 2. 确保客户端登录并获取 CAS Service Ticket
  const service = 'https://eaichat.ctyun.cn:443/chat/#/aichat';

  async function getCasTicket(forceRefresh = false) {
    if (forceRefresh) {
      onLog('AIChat', `正在刷新天翼云客户端认证凭据...`, 'info');
      try {
        if (typeof client.renewToken === 'function') {
          await client.renewToken();
        } else if (typeof client.login === 'function') {
          client.loginInfo = null;
          await client.login();
        }
      } catch (err) {
        onLog('AIChat', `凭据续期尝试失败 (${err.message})，使用现有凭据重试...`, 'warning');
      }
    } else if (!client.loginInfo) {
      onLog('AIChat', `正在刷新天翼云客户端认证会话...`, 'info');
      const loginRes = await client.login();
      if (!loginRes.success) throw new Error(loginRes.error || '登录失败');
    }

    const authData = client.loginInfo;
    if (!authData) throw new Error('账号尚未登录');

    const nowTs = Date.now().toString();
    const ver = client.version || '103020001';
    const sigStr = `${client.deviceType}${nowTs}${authData.tenantId}${nowTs}${authData.userId}${ver}${authData.secretKey}`;

    let headers;
    if (typeof client.getSignedHeaders === 'function') {
      headers = client.getSignedHeaders();
    } else {
      headers = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
        'ctg-devicetype': client.deviceType,
        'ctg-version': ver,
        'ctg-devicecode': acc.deviceCode,
        'ctg-userid': String(authData.userId),
        'ctg-tenantid': String(authData.tenantId),
        'ctg-timestamp': nowTs,
        'ctg-requestid': nowTs,
        'ctg-signaturestr': md5(sigStr),
        'Referer': 'https://pc.ctyun.cn/'
      };
      if (authData.token) {
        headers['Cookie'] = `token=${authData.token}`;
      }
    }

    const ticketUrl = `https://desk.ctyun.cn:8810/api/auth/client/getTicket?service=${encodeURIComponent(service)}`;
    const resp = await netFetch('[2/4] 获取 CAS Ticket getTicket', ticketUrl, { headers }, onLog);
    return await resp.json();
  }

  onLog('AIChat', `请求天翼 CAS 单点登录 Ticket 票据...`, 'info');
  let ticketRes = await getCasTicket(false);

  // 40010 或未取得 ticket：长效运行容器中内存 token 过期，自动静默续期并重试一次
  if (ticketRes.code === 40010 || ticketRes.code === '40010' || !ticketRes.data?.ticket) {
    onLog('AIChat', `CAS Ticket 提示会话失效或未返回票据 (${ticketRes.msg || ticketRes.code || '无Ticket'})，正在自动重新续期凭据...`, 'info');
    ticketRes = await getCasTicket(true);
  }

  if (!ticketRes.data || !ticketRes.data.ticket) {
    throw new Error('获取 CAS Ticket 失败: ' + (ticketRes.msg || JSON.stringify(ticketRes)));
  }
  const ticket = ticketRes.data.ticket;

  // 3. 生成 16 字节随机密钥并使用 RSA-PKCS1 加密
  onLog('AIChat', `RSA-PKCS1 加密生成客户端鉴权凭据，换取对话会话密钥 (SessionKey)...`, 'info');
  const chars = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let clientKey = '';
  for (let i = 0; i < 16; i++) clientKey += chars[Math.floor(Math.random() * chars.length)];
  const pem = `-----BEGIN PUBLIC KEY-----\n${ssopk}\n-----END PUBLIC KEY-----`;
  const encClientKey = crypto.publicEncrypt({ key: pem, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(clientKey, 'utf8')).toString('hex');

  const authParams = new URLSearchParams();
  authParams.append('loginType', 'iamTicket');
  authParams.append('clientId', 'eaiapp');
  authParams.append('iamTicket', ticket);
  authParams.append('redirectUri', service);
  authParams.append('clientKey', encClientKey);
  authParams.append('clientKeyId', ssopkid);

  await diagDns('AI 对话站', 'eaichat.ctyun.cn', onLog);
  const authPostRes = await netFetch('[3/4] SSO Ticket 换取 sessionKey', 'https://eaichat.ctyun.cn/sso/login/v2/iam/ticketAuthorize', {
    method: 'POST',
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'Referer': 'https://eaichat.ctyun.cn/chat/',
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: authParams.toString()
  }, onLog);

  const authJson = await authPostRes.json();
  if (authJson.resultCode !== 0 || !authJson.data?.sessionKey) {
    throw new Error('SSO Ticket 鉴权换取失败: ' + (authJson.resultMsg || JSON.stringify(authJson)));
  }

  let rawCookies = '';
  if (typeof authPostRes.headers.getSetCookie === 'function') {
    rawCookies = authPostRes.headers.getSetCookie().join('; ');
  } else {
    rawCookies = authPostRes.headers.get('set-cookie') || '';
  }
  const ylTokenMatch = rawCookies.match(/YL-Token=([^;]+)/);
  const ylSsidMatch = rawCookies.match(/YL-Ssid=([^;]+)/);
  const ylToken = ylTokenMatch ? ylTokenMatch[1] : (authPostRes.headers.get('yl-authorization') || '');
  const ylSsid = ylSsidMatch ? ylSsidMatch[1] : '';
  const cookieHeader = `YL-Token=${ylToken}; YL-Ssid=${ylSsid}`;

  const decipherSk = crypto.createDecipheriv('aes-128-ecb', Buffer.from(clientKey, 'utf8'), null);
  let sk = decipherSk.update(authJson.data.sessionKey, 'base64', 'utf8');
  sk += decipherSk.final('utf8');

  // 4. 发送 AI 对话请求
  const prompt = PRESET_MESSAGES[Math.floor(Math.random() * PRESET_MESSAGES.length)];
  onLog('AIChat', `向天翼云智助手发送对话指令: "${prompt}"...`, 'info');

  const chatBody = {
    key_model: 'telechat',
    messages: [
      { role: 'user', content: prompt }
    ],
    stream: false,
    client_retry: true,
    web_search: false
  };

  const bodyJsonStr = JSON.stringify(chatBody);
  const dataMd5 = md5(bodyJsonStr);
  const ts = Date.now().toString();
  let rnd = '';
  for (let i = 0; i < 8; i++) rnd += chars[Math.floor(Math.random() * chars.length)];
  const rawSign = `${dataMd5}&${sk}&${ts}&${rnd}`;
  const webSign = sha256(rawSign);
  const traceId = crypto.randomUUID();

  const chatRes = await netFetch('[4/4] 发送 AI 对话请求', 'https://eaichat.ctyun.cn/ai/portal/v3/openai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Cookie': cookieHeader,
      'YL-Authorization': ylToken,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/137.0.0.0',
      'Referer': 'https://eaichat.ctyun.cn/chat/',
      'Origin': 'https://eaichat.ctyun.cn',
      'x-client-trace-id': traceId,
      'x-eai-source': 'web-eai',
      'x-eai-version': '202060305',
      'YL-Main-Version': '202060305',
      'YL-Product-Id': '5',
      'Web-Signature': webSign,
      'Web-Random': rnd,
      'Web-Timestamp': ts
    },
    body: bodyJsonStr
  }, onLog);

  if (!chatRes.ok) {
    throw new Error(`AI 对话接口异常 (HTTP ${chatRes.status})`);
  }

  const resText = await chatRes.text();
  try {
    const chatJson = JSON.parse(resText);
    if (chatJson.code && chatJson.code !== 0 && chatJson.code !== 200) {
      throw new Error(`AI 对话业务返回错误: ${chatJson.message || chatJson.msg || resText}`);
    }
  } catch (e) {
    if (e.message && e.message.startsWith('AI 对话业务返回错误')) throw e;
  }
  onLog('AIChat', `✅ AI 对话成功完成！已获取今日 100 积分！(全流程耗时 ${Math.round((Date.now() - flowStartedAt) / 1000)}s)`, 'success');
  
  await client.refreshOfficialTasks();
  return { success: true, message: 'AI 对话成功完成，积分已刷新' };
}

/**
 * 登录打卡 (真实完成天翼云官方【登录AI云电脑】任务，彻底与 40050 tokenLogin 解耦)
 */
async function executeNativeSign(client, acc, onLog = console.log) {
  const accName = acc.name || acc.user;
  onLog('Sign', `正在执行天翼云官方【登录AI云电脑】打卡认证...`, 'info');
  try {
    // 0. 账号级开关：统一入口判定
    if (typeof client.resolveTask === 'function') {
      const accGate = client.resolveTask('sign');
      if (!accGate.enabled) {
        onLog('Sign', `[${accName}] ${accGate.reason}，本次登录打卡自动跳过。`, 'info');
        return { success: true, isCompleted: false, message: accGate.reason };
      }
    }

    // 1. 检查今日是否已在官方任务中心完成
    const preRefresh = await client.refreshOfficialTasks();
    const loginTaskDone = () => {
      const t = (client.metrics.officialTasks || []).find(x => x.name.includes('登录AI云电脑') || x.name.includes('登录'));
      return !!(t && (t.status === 2 || (t.total > 0 && t.current >= t.total)));
    };
    const alreadyDone = typeof client.isSignTaskDone === 'function' ? client.isSignTaskDone() : loginTaskDone();
    if (alreadyDone) {
      onLog('Sign', `✅ 今日登录打卡任务已在官方达成 (+100积分)，无需重复执行。`, 'success');
      if (typeof client.clearSignVerify === 'function') client.clearSignVerify();
      return { success: true, isCompleted: true, message: '今日已完成登录打卡' };
    }
    // 官方状态不可读时不得贸然认领
    if (preRefresh && preRefresh.ok === false) {
      onLog('Sign', `[${accName}] 官方任务中心暂不可读 (${preRefresh.reason})，无法确认今日打卡状态。为避免盲目认领抢占，本次暂不认领，已安排复检。`, 'warning');
      if (typeof client.scheduleSignVerify === 'function') client.scheduleSignVerify(onLog);
      return { success: true, isCompleted: false, pendingVerify: true, message: '官方状态不可读，本次暂不认领' };
    }

    // 2. 状态避让与互斥检查：如果当前正在执行 1 小时挂机任务，挂机会话本身即发送 112/104 桌面认领，直接复用
    if (client.isTaskHanging) {
      onLog('Sign', `[${accName}] ⏱️ 云电脑当前正处于 1 小时挂机会话中，桌面正在认领，打卡自动复用挂机会话。`, 'info');
      return { success: true, isCompleted: false, message: '挂机会话正在执行认领' };
    }

    // 3. 用户浏览器操作或客户端避让期：主动避让
    if (client.isWebUserActive && Date.now() < client.webUserActiveUntil) {
      onLog('Sign', `[${accName}] 浏览器用户正在操作云电脑，本次不认领抢占；改为复检官方任务中心。`, 'info');
      if (typeof client.scheduleSignVerify === 'function') client.scheduleSignVerify(onLog);
      return { success: true, isCompleted: false, message: '浏览器用户操作中，改为等待官方确认' };
    }
    if (Date.now() < client.externalYieldUntil) {
      const waitMin = Math.ceil((client.externalYieldUntil - Date.now()) / 60000);
      onLog('Sign', `[${accName}] 官方客户端近期活跃处于避让期 (剩余 ${waitMin} 分钟)，本次不认领抢占；改为复检官方任务中心。`, 'info');
      if (typeof client.scheduleSignVerify === 'function') client.scheduleSignVerify(onLog);
      return { success: true, isCompleted: false, message: '处于客户端避让冷却期，改为等待官方确认' };
    }

    // 3.1 今日已下发过认领且仍在待确认期：绝不重复认领
    if (client.signVerifyPendingSince) {
      const waitedMin = Math.floor((Date.now() - client.signVerifyPendingSince) / 60000);
      onLog('Sign', `[${accName}] 今日登录认领已下发，仍在等待官方确认 (已等待约 ${waitedMin} 分钟)。本次不再重复认领，继续复检官方任务中心。`, 'info');
      if (typeof client.scheduleSignVerify === 'function') client.scheduleSignVerify(onLog);
      return { success: true, isCompleted: false, pendingVerify: true, message: '认领已下发，等待官方确认（复检中）' };
    }

    // 4. 获取目标云电脑（优选已开机运行的主机）
    const desktops = await client.getDesktops().catch(() => []);
    if (!desktops || desktops.length === 0) {
      onLog('Sign', `[${accName}] 账号名下暂无可用的云电脑主机。`, 'warning');
      return { success: true, isCompleted: false, message: '名下无可用云电脑' };
    }
    const taskOnDesktops = typeof client.resolveTask === 'function'
      ? desktops.filter(d => client.resolveTask('sign', d).enabled)
      : desktops.filter(d => d.taskEnabled !== false);
    if (taskOnDesktops.length === 0) {
      onLog('Sign', `[${accName}] 账号名下所有云电脑的【🎯 任务】开关均已关闭，跳过桌面登录认领。`, 'info');
      return { success: true, isCompleted: false, message: '任务开关已关闭' };
    }

    const isRunning = (d) => d && (d.useStatusText === '运行中' || d.useStatus == 25);
    const runningDesktop = taskOnDesktops.find(d => isRunning(d));
    const mainDesktop = runningDesktop || taskOnDesktops[0];
    const targetName = mainDesktop.objName || mainDesktop.desktopName || '云电脑';
    const targetId = String(mainDesktop.objId || mainDesktop.desktopId);

    // 5. 若未开机：根据自动开机配置决定是否唤醒
    if (!isRunning(mainDesktop)) {
      if (mainDesktop.autoBootEnabled !== false) {
        onLog('Sign', `[${accName}][${targetName}] 云电脑未开机，正在下发开机唤醒指令以完成【登录AI云电脑】打卡...`, 'info');
        await client.controlPower(targetId, 'poweron').catch(() => {});
        for (let i = 0; i < 6; i++) {
          await new Promise(r => setTimeout(r, 10000));
          const fresh = await client.getDesktops().catch(() => []);
          const target = (fresh || []).find(d => String(d.objId || d.desktopId) === targetId);
          if (isRunning(target)) break;
        }
      } else {
        onLog('Sign', `[${accName}][${targetName}] 云电脑当前关机且未开启自动开机，已完成基本账号鉴权；待开机或运行挂机任务时将自动达成【登录AI云电脑】。`, 'info');
        return { success: true, isCompleted: false, message: '云电脑关机待唤醒' };
      }
    }

    // 6. 核心认证：建立桌面认领会话并向视讯网关下发 118身份 + 112登录凭据 + 104握手确认包
    onLog('Sign', `[${accName}][${targetName}] 正在建立视讯网关桌面登录认领会话 (Type 118/112/104)，保持观察等待官方确认...`, 'info');

    const snapSignTask = () => {
      const t = client.metrics.officialTasks?.find(x => x.name.includes('登录AI云电脑') || x.name.includes('登录'));
      return t ? `status=${t.status} ${t.current || 0}/${t.total || 0}` : '未取到任务项';
    };
    const signClaimStartedAt = Date.now();
    onLog('Sign', `[${accName}][${targetName}] [诊断] 认领前官方任务中心: ${snapSignTask()}`, 'info');

    // 独立会话占用标记：仅用于让常态脉冲循环避让，绝不触碰挂机任务的 isTaskHanging 状态位
    client._signSessionActive = true;
    let claimResult = null;
    try {
      if (client.endCurrentSession) {
        client.endCurrentSession('Yield to Sign Claim');
      }
      claimResult = await client.runDesktopKeepAliveSession(mainDesktop, true, 300, '登录AI云电脑');
    } finally {
      client._signSessionActive = false;
    }

    onLog('Sign', `[${accName}][${targetName}] [诊断] 认领会话结束 (设定 300s / 实际 ${Math.round((Date.now() - signClaimStartedAt) / 1000)}s)，结束原因: ${(claimResult && claimResult.reason) || '(窗口到期)'}，会话内目标确认: ${claimResult && claimResult.goalAchieved ? '是' : '否'}`, 'info');

    // 7. 判定：以官方任务中心为准
    const postRefresh = await client.refreshOfficialTasks();
    const isDone = typeof client.isSignTaskDone === 'function' ? client.isSignTaskDone() : loginTaskDone();
    const inSessionConfirmed = !!(claimResult && claimResult.goalAchieved);
    const claimReason = (claimResult && claimResult.reason) || '';
    const refreshReadable = !(postRefresh && postRefresh.ok === false);

    onLog('Sign', `[${accName}][${targetName}] [诊断] 认领后官方任务中心: ${snapSignTask()} → 会话内确认=${inSessionConfirmed} / 官方状态确认=${isDone} / 官方数据可读=${refreshReadable}`, 'info');

    if (inSessionConfirmed || isDone) {
      onLog('Sign', `🎉 官方任务中心已确认【登录AI云电脑】达成 (+100积分)！`, 'success');
      if (typeof client.clearSignVerify === 'function') client.clearSignVerify();
      return { success: true, isCompleted: true, message: '官方已确认登录打卡完成' };
    }

    if (!refreshReadable) {
      onLog('Sign', `[${accName}][${targetName}] ⚠️ 认领已完成，但官方任务中心本次不可读 (${(postRefresh && postRefresh.reason) || '原因未知'})，无法判定成败。已安排复检。`, 'warning');
    } else if (claimReason === 'Preempted by Client' || claimReason === 'Yield to External Client' || claimReason === 'Yield to Web User') {
      onLog('Sign', `[${accName}][${targetName}] 认领会话因官方客户端接入/用户操作而主动让位 (${claimReason})，本次未确认达成。已安排复检官方任务中心。`, 'warning');
    } else {
      onLog('Sign', `[${accName}][${targetName}] 认领会话已完成并释放通道，但官方任务中心暂未确认【登录AI云电脑】。官方落账存在分钟级延迟，本次结论为【未确认】，已安排跨分钟复检。`, 'info');
    }

    if (typeof client.scheduleSignVerify === 'function') {
      client.scheduleSignVerify(onLog);
    } else {
      onLog('Sign', `[${accName}] ⚠️ 缺少复检调度能力，本次打卡结论为【未确认】，请稍后手动刷新官方任务中心核对。`, 'warning');
    }
    return { success: true, isCompleted: false, pendingVerify: true, message: '认领已下发，等待官方确认（已安排复检，期间不会重复认领）' };
  } catch (e) {
    onLog('Sign', `登录打卡异常: ${e.message}`, 'error');
    throw e;
  }
}

/**
 * 云电脑定时挂机任务
 */
async function executeNativeHang(client, acc, onLog = console.log) {
  if (client && typeof client.runHangTask === 'function') {
    return await client.runHangTask(onLog);
  }

  await client.refreshOfficialTasks();
  const hangTask = client.metrics.officialTasks?.find(t => t.name.includes('使用1小时'));
  const isDone = hangTask && (hangTask.status === 2 || (hangTask.total > 0 && hangTask.current >= hangTask.total));
  return { success: true, isCompleted: isDone, message: isDone ? '今日挂机时长已满 1 小时' : '挂机任务就绪' };
}

module.exports = {
  executeNativeAiChat,
  executeNativeSign,
  executeNativeHang
};
