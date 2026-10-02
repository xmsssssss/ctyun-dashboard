const { executeNativeAiChat, executeNativeSign, executeNativeHang } = require('./native_tasks');

function getBeijingDate() {
  const d = new Date();
  return new Date(d.toLocaleString('en-US', { timeZone: 'Asia/Shanghai' }));
}

function getBeijingDateStr() {
  const d = new Date();
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function getBeijingTimeString() {
  const d = new Date();
  return d.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

function matchCronField(field, val) {
  if (field === '*') return true;
  const parts = field.split(',');
  for (const part of parts) {
    if (part.includes('/')) {
      const [range, step] = part.split('/');
      const stepNum = parseInt(step, 10);
      if (range === '*') {
        if (val % stepNum === 0) return true;
      } else {
        const [start, end] = range.split('-').map(Number);
        if (val >= start && val <= end && (val - start) % stepNum === 0) return true;
      }
    } else if (part.includes('-')) {
      const [start, end] = part.split('-').map(Number);
      if (val >= start && val <= end) return true;
    } else {
      if (parseInt(part, 10) === val) return true;
    }
  }
  return false;
}

function shouldRunCron(cronExpr, date = new Date()) {
  if (!cronExpr) return false;
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  const [minStr, hourStr, domStr, monthStr, dowStr] = parts;
  const min = date.getMinutes();
  const hour = date.getHours();
  const dom = date.getDate();
  const month = date.getMonth() + 1;
  const dow = date.getDay();

  return matchCronField(minStr, min) &&
         matchCronField(hourStr, hour) &&
         matchCronField(domStr, dom) &&
         matchCronField(monthStr, month) &&
         matchCronField(dowStr, dow);
}

class TaskScheduler {
  constructor({ getAccounts, getSettings, getClient, appendLog, sendNotification, saveConfig }) {
    this.getAccounts = getAccounts;
    this.getSettings = getSettings;
    this.getClient = getClient;
    this.appendLog = appendLog;
    this.sendNotification = sendNotification;
    this.saveConfig = saveConfig;
    this.timer = null;
    this.lastTriggerMinute = '';
    this.lastCompletedDate = '';
    this.isRunning = false;
  }

  /**
   * 开关语义统一入口，杜绝字段名漂移 (sign -> autoSign)
   */
  taskGate(acc, taskType, client) {
    const c = client || this.getClient(acc);
    if (c && typeof c.resolveTask === 'function') {
      return c.resolveTask(taskType).enabled;
    }
    const key = taskType === 'sign' ? 'autoSign' : taskType;
    if (acc.enabled === false) return false;
    return (acc.features || {})[key] !== false;
  }

  start() {
    this.appendLog('Scheduler', '⏰ 自动化调度引擎已启动 (准时时间点主导 + 30秒无缝巡检)...', 'success');
    this.scheduleNextRun();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => this.heartbeatTick(), 30000);
    setTimeout(() => this.checkStartupCatchup(), 2000);
  }

  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.nextRunTimer) {
      clearTimeout(this.nextRunTimer);
      this.nextRunTimer = null;
    }
  }

  getTargetTimes() {
    const settings = this.getSettings() || {};
    const cron = settings.cron || {};
    const rawTimes = cron.executeTime || cron.taskTime || '01:20';
    const list = rawTimes.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean);
    return list.length > 0 ? list : ['01:20'];
  }

  /**
   * 分项管辖表：分项 Cron 一旦填写，该分项完全由其自己的 Cron 精准管辖，
   * 主时间点与开机补跑一律跳过，绝不重复执行。
   */
  getSubCronMap() {
    const settings = this.getSettings() || {};
    const cron = settings.cron || {};
    if (!cron.enableSubCron) {
      return { sign: false, aiChat: false, cloudHang: false, redeem: false };
    }
    return {
      sign: !!cron.signCron?.trim(),
      aiChat: !!cron.aiChatCron?.trim(),
      cloudHang: !!cron.cloudHangCron?.trim(),
      redeem: !!cron.redeemCron?.trim()
    };
  }

  /**
   * 根据分项管辖表生成主调度需排除的任务类型列表与中文描述
   */
  getExcludedTasksInfo(excludeSet) {
    const names = { sign: '每日签到', aiChat: 'AI 对话', cloudHang: '云电脑挂机', redeem: '自动兑换' };
    const excluded = Object.keys(names).filter(k => excludeSet[k]);
    return { list: excluded, text: excluded.map(k => names[k]).join('、') || '无' };
  }

  /**
   * 开机或配置热更新时自检：分项级补跑兜底
   */
  async checkStartupCatchup() {
    const todayStr = getBeijingDateStr();
    const accounts = this.getAccounts() || [];
    const subCronMap = this.getSubCronMap();

    let anyUngovernedTask = false;
    for (const acc of accounts) {
      if (!acc.enabled) continue;
      const f = acc.features || {};
      if ((this.taskGate(acc, 'sign') && !subCronMap.sign) ||
          (this.taskGate(acc, 'aiChat') && !subCronMap.aiChat) ||
          (this.taskGate(acc, 'cloudHang') && !subCronMap.cloudHang) ||
          (f.autoRedeem && !subCronMap.redeem)) {
        anyUngovernedTask = true;
        break;
      }
    }

    if (!anyUngovernedTask) {
      this.appendLog('Scheduler', `🛰️ 所有任务分项均由独立 Cron 精准管辖，开机补跑引擎转入休眠，各分项将由其 Cron 在匹配时间点独立触发。`, 'info');
      return;
    }

    let allDone = accounts.length > 0;
    for (const acc of accounts) {
      if (!acc.enabled) continue;
      const client = this.getClient(acc);
      try {
        await client.refreshOfficialTasks();
      } catch (e) {}
      const tasks = client?.metrics?.officialTasks || [];

      const loginTask = tasks.find(t => t.name.includes('登录AI云电脑'));
      const aiTask = tasks.find(t => t.name.includes('AI对话'));
      const hangTask = tasks.find(t => t.name.includes('使用1小时'));

      if (this.taskGate(acc, 'sign') && !subCronMap.sign && !(loginTask && (loginTask.status === 2 || loginTask.current >= loginTask.total))) {
        allDone = false;
        break;
      }
      if (this.taskGate(acc, 'aiChat') && !subCronMap.aiChat && !(aiTask && (aiTask.status === 2 || aiTask.current >= aiTask.total))) {
        allDone = false;
        break;
      }
      if (this.taskGate(acc, 'cloudHang') && !subCronMap.cloudHang && !(hangTask && (hangTask.status === 2 || hangTask.current >= hangTask.total))) {
        allDone = false;
        break;
      }
    }

    if (allDone) {
      this.lastCompletedDate = todayStr;
      this.appendLog('Scheduler', `✅ 检测确认：未由独立 Cron 管辖的自动化任务今日均已圆满达成，转入低功耗休眠。`, 'success');
      return;
    }

    const targetTimes = this.getTargetTimes();
    const bj = getBeijingDate();
    const currentVal = bj.getHours() * 60 + bj.getMinutes();

    let shouldCatchup = false;
    for (const t of targetTimes) {
      const parts = t.split(':').map(Number);
      const tVal = parts[0] * 60 + (parts[1] || 0);
      if (currentVal >= tVal) {
        shouldCatchup = true;
        break;
      }
    }

    if (shouldCatchup && this.lastCompletedDate !== todayStr) {
      const excludedTasks = this.getExcludedTasksInfo(subCronMap);
      this.appendLog('Scheduler', `🚀 准时补跑机制触发：当前时间 (${String(bj.getHours()).padStart(2, '0')}:${String(bj.getMinutes()).padStart(2, '0')}) 已达或超过预设时间点 (${targetTimes.join(', ')})，执行分项级自动补跑...`, 'info');
      if (excludedTasks.list.length > 0) {
        this.appendLog('Scheduler', `🛰️ 以下分项由独立 Cron 管辖，本次补跑跳过: ${excludedTasks.text} (将由其 Cron 在下一个匹配时间点触发)`, 'info');
      }
      await this.runAllAccounts('catchup_or_scheduled', subCronMap);
    }
  }

  /**
   * 计算下次触发时间并挂载精确的延时器
   */
  scheduleNextRun() {
    if (this.nextRunTimer) {
      clearTimeout(this.nextRunTimer);
      this.nextRunTimer = null;
    }

    const targetTimes = this.getTargetTimes();
    const bj = getBeijingDate();
    const currentMs = bj.getTime();

    let nextTargetDate = null;
    for (const timeStr of targetTimes) {
      const [h, m] = timeStr.split(':').map(Number);
      const candidate = new Date(bj.getTime());
      candidate.setHours(h, m, 0, 0);
      if (candidate.getTime() > currentMs) {
        if (!nextTargetDate || candidate.getTime() < nextTargetDate.getTime()) {
          nextTargetDate = candidate;
        }
      }
    }

    if (!nextTargetDate) {
      const [h, m] = targetTimes[0].split(':').map(Number);
      const tomorrow = new Date(bj.getTime() + 24 * 3600 * 1000);
      tomorrow.setHours(h, m, 0, 0);
      nextTargetDate = tomorrow;
    }

    const delayMs = Math.max(1000, nextTargetDate.getTime() - currentMs);
    const targetH = String(nextTargetDate.getHours()).padStart(2, '0');
    const targetM = String(nextTargetDate.getMinutes()).padStart(2, '0');
    const hoursAway = (delayMs / 3600000).toFixed(1);

    this.appendLog('Scheduler', `⏰ 下一次自动化任务将在北京时间 ${targetH}:${targetM} 准时执行 (约 ${hoursAway} 小时后)。`, 'info');

    this.nextRunTimer = setTimeout(async () => {
      const subCronMap = this.getSubCronMap();
      const excludedTasks = this.getExcludedTasksInfo(subCronMap);
      if (excludedTasks.list.length > 0) {
        this.appendLog('Scheduler', `⏰ 到达主调度时间点，以下分项由独立 Cron 精准管辖，本次主调度跳过: ${excludedTasks.text}`, 'info');
      }
      await this.runAllAccounts('point_in_time', subCronMap);
      this.scheduleNextRun();
    }, delayMs);
  }

  /**
   * 判断辅助规则是否启用且包含有效规则
   */
  hasActiveSubCronRules() {
    const settings = this.getSettings() || {};
    const cron = settings.cron || {};
    if (!cron.enableSubCron) return false;
    return !!(cron.signCron?.trim() || cron.aiChatCron?.trim() || cron.cloudHangCron?.trim() || cron.redeemCron?.trim());
  }

  /**
   * 30 秒巡检看门狗
   */
  async heartbeatTick() {
    const bj = getBeijingDate();
    const currentMinKey = bj.toISOString().substring(0, 16);
    if (this.lastTriggerMinute === currentMinKey) return;

    const currentHm = `${String(bj.getHours()).padStart(2, '0')}:${String(bj.getMinutes()).padStart(2, '0')}`;
    const targetTimes = this.getTargetTimes();
    const todayStr = getBeijingDateStr();

    const settings = this.getSettings() || {};
    const cron = settings.cron || {};
    const subCronActive = this.hasActiveSubCronRules();

    if (!subCronActive) {
      if (targetTimes.includes(currentHm)) {
        this.lastTriggerMinute = currentMinKey;
        if (this.lastCompletedDate !== todayStr) {
          this.appendLog('Scheduler', `⏰ 到达主调度中心每日任务准时触发时间点 [${currentHm}]，正在启动全自动流程...`, 'info');
          await this.runAllAccounts('scheduled_point');
          this.scheduleNextRun();
          return;
        }
      }
      return;
    }

    const accounts = (this.getAccounts() || []).filter(a => a.enabled);

    // 2.1 每日签到打卡分项规则
    if (cron.signCron?.trim()) {
      if (shouldRunCron(cron.signCron.trim(), bj)) {
        this.lastTriggerMinute = currentMinKey;
        this.appendLog('Scheduler', `⏰ 触发分项辅助规则 [签到打卡] (Cron: ${cron.signCron})...`, 'info');
        for (const acc of accounts) {
          if (this.taskGate(acc, 'sign')) {
            const client = this.getClient(acc);
            executeNativeSign(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl))
              .then(signRes => {
                if (signRes && signRes.isCompleted) {
                  acc.stats.lastSignTime = getBeijingTimeString();
                  this.saveConfig();
                }
              })
              .catch(() => {});
          }
        }
      }
    } else if (targetTimes.includes(currentHm) && this.lastCompletedDate !== todayStr) {
      for (const acc of accounts) {
        if (this.taskGate(acc, 'sign')) {
          const client = this.getClient(acc);
          executeNativeSign(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl))
            .then(signRes => {
              if (signRes && signRes.isCompleted) {
                acc.stats.lastSignTime = getBeijingTimeString();
                this.saveConfig();
              }
            })
            .catch(() => {});
        }
      }
    }

    // 2.2 AI 智能对话分项规则
    if (cron.aiChatCron?.trim()) {
      if (shouldRunCron(cron.aiChatCron.trim(), bj)) {
        this.lastTriggerMinute = currentMinKey;
        this.appendLog('Scheduler', `⏰ 触发分项辅助规则 [AI 对话] (Cron: ${cron.aiChatCron})...`, 'info');
        for (const acc of accounts) {
          if (this.taskGate(acc, 'aiChat')) {
            const client = this.getClient(acc);
            executeNativeAiChat(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl)).catch(() => {});
          }
        }
      }
    } else if (targetTimes.includes(currentHm) && this.lastCompletedDate !== todayStr) {
      for (const acc of accounts) {
        if (this.taskGate(acc, 'aiChat')) {
          const client = this.getClient(acc);
          executeNativeAiChat(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl)).catch(() => {});
        }
      }
    }

    // 2.3 云电脑挂机分项规则
    if (cron.cloudHangCron?.trim()) {
      if (shouldRunCron(cron.cloudHangCron.trim(), bj)) {
        this.lastTriggerMinute = currentMinKey;
        this.appendLog('Scheduler', `⏰ 触发分项辅助规则 [云电脑挂机] (Cron: ${cron.cloudHangCron})...`, 'info');
        for (const acc of accounts) {
          if (this.taskGate(acc, 'cloudHang')) {
            const client = this.getClient(acc);
            executeNativeHang(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl)).catch(() => {});
          }
        }
      }
    } else if (targetTimes.includes(currentHm) && this.lastCompletedDate !== todayStr) {
      for (const acc of accounts) {
        if (this.taskGate(acc, 'cloudHang')) {
          const client = this.getClient(acc);
          executeNativeHang(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl)).catch(() => {});
        }
      }
    }

    // 2.4 自动兑换分项规则
    if (cron.redeemCron?.trim()) {
      if (shouldRunCron(cron.redeemCron.trim(), bj)) {
        this.lastTriggerMinute = currentMinKey;
        this.appendLog('Scheduler', `⏰ 触发分项辅助规则 [自动兑换/抽奖] (Cron: ${cron.redeemCron})...`, 'info');
        for (const acc of accounts) {
          if (acc.features?.autoRedeem) {
            const client = this.getClient(acc);
            client.getRewards().catch(() => {});
          }
        }
      }
    }
  }

  /**
   * 执行所有账号的自动化任务流
   * @param {string} reason 触发来源标识
   * @param {object|null} excludeSet 分项排除表
   */
  async runAllAccounts(reason = 'scheduled', excludeSet = null) {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const todayStr = getBeijingDateStr();
      const accounts = (this.getAccounts() || []).filter(a => a.enabled);

      this.appendLog('Scheduler', `🔔 开始按序执行 ${accounts.length} 个天翼云电脑的任务流程 (触发来源: ${reason})...`, 'info');

      const summaryResults = [];

      const sleepStepJitter = async (accName, stepName) => {
        const ms = Math.floor(Math.random() * 3000) + 2000;
        this.appendLog('Scheduler', `[${accName}] 🛡️ [防风控] 任务步骤 (${stepName}) 间随机防抖，等待 ${(ms / 1000).toFixed(1)} 秒...`, 'info');
        await new Promise(r => setTimeout(r, ms));
      };

      for (let i = 0; i < accounts.length; i++) {
        const acc = accounts[i];
        const client = this.getClient(acc);
        const accSummary = { name: acc.name, sign: false, aiChat: false, hang: false };

        if (client?.isWebUserActive) {
          this.appendLog('Scheduler', `[${acc.name}] 用户当前正在浏览器中远程操控云电脑，为避免会话冲突，本次自动化调度主动避让跳过。`, 'info');
          continue;
        }

        try {
          // 1. 底层长连接保活守护
          if (!client.wsAlive && this.taskGate(acc, 'keepAlive')) {
            client.startKeepAliveWorker();
          }

          // 2. 原生登录打卡
          if (this.taskGate(acc, 'sign')) {
            if (excludeSet?.sign) {
              this.appendLog('Scheduler', `[${acc.name}] 分项 [每日签到] 由独立 Cron 管辖，本次主调度跳过。`, 'info');
            } else {
              try {
                const signRes = await executeNativeSign(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl));
                if (signRes && signRes.isCompleted) {
                  acc.stats.lastSignTime = getBeijingTimeString();
                  accSummary.sign = true;
                }
              } catch (e) {
                this.appendLog('Sign', `[${acc.name}] 打卡未达标: ${e.message}`, 'error');
              }
              await sleepStepJitter(acc.name, '打卡 -> AI 对话');
            }
          }

          // 3. 原生 AI 智能对话
          if (this.taskGate(acc, 'aiChat')) {
            if (excludeSet?.aiChat) {
              this.appendLog('Scheduler', `[${acc.name}] 分项 [AI 对话] 由独立 Cron 管辖，本次主调度跳过。`, 'info');
            } else {
              try {
                await executeNativeAiChat(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl));
                acc.stats.lastAiChatTime = getBeijingTimeString();
                accSummary.aiChat = true;
              } catch (e) {
                this.appendLog('AIChat', `[${acc.name}] AI 对话未达标: ${e.message}`, 'error');
              }
              await sleepStepJitter(acc.name, 'AI 对话 -> 挂机检测');
            }
          }

          // 4. 原生云电脑挂机守护检测
          if (this.taskGate(acc, 'cloudHang')) {
            if (excludeSet?.cloudHang) {
              this.appendLog('Scheduler', `[${acc.name}] 分项 [云电脑挂机] 由独立 Cron 管辖，本次主调度跳过。`, 'info');
            } else {
              try {
                const hangRes = await executeNativeHang(client, acc, (src, msg, lvl) => this.appendLog(src, `[${acc.name}] ${msg}`, lvl));
                accSummary.hang = (hangRes && hangRes.isCompleted === true);
              } catch (e) {
                this.appendLog('Hang', `[${acc.name}] 挂机状态检测异常: ${e.message}`, 'error');
              }
              if (acc.features?.autoRedeem) {
                await sleepStepJitter(acc.name, '挂机检测 -> 自动兑换');
              }
            }
          }

          // 5. 自动兑换（原子总积分下单）
          if (acc.features?.autoRedeem) {
            if (excludeSet?.redeem) {
              this.appendLog('Scheduler', `[${acc.name}] 分项 [自动兑换] 由独立 Cron 管辖，本次主调度跳过。`, 'info');
            } else {
              try {
                const rConf = acc.redeemConfig || {};
                const todayStr = getBeijingDateStr();

                if (rConf.lastRedeemDate !== todayStr && rConf.prodId) {
                  const cstDay = parseInt(todayStr.split('-')[2], 10);
                  const ym = todayStr.split('-');
                  const lastDayOfMonth = new Date(Number(ym[0]), Number(ym[1]), 0).getDate();
                  let shouldRedeem = false;
                  let reason = '';

                  if (rConf.scheduleType === 'daily') {
                    shouldRedeem = true;
                    reason = '命中每日兑换策略';
                  } else if (rConf.scheduleType === 'interval_days') {
                    if (!rConf.lastRedeemDate) {
                      shouldRedeem = true;
                      reason = '首次执行间隔兑换';
                    } else {
                      const diffDays = Math.floor((new Date(todayStr).getTime() - new Date(rConf.lastRedeemDate).getTime()) / (1000 * 3600 * 24));
                      if (diffDays >= (parseInt(rConf.intervalDays) || 30)) {
                        shouldRedeem = true;
                        reason = `已间隔 ${diffDays} 天，达到设定的 ${rConf.intervalDays} 天`;
                      }
                    }
                  } else {
                    const days = Array.isArray(rConf.monthlyDays) ? rConf.monthlyDays : [-1];
                    if (days.includes(cstDay) || (days.includes(-1) && cstDay === lastDayOfMonth)) {
                      shouldRedeem = true;
                      reason = (days.includes(-1) && cstDay === lastDayOfMonth) ? `命中月末最后一天 (${cstDay}号) 兑换策略` : `命中每月 ${cstDay} 号兑换策略`;
                    }
                  }

                  if (shouldRedeem) {
                    const prodType = rConf.prodType || 'pointstplupgrade';
                    const pId = Number(rConf.prodId);
                    const needsDesktop = [17023101, 17023111, 17024101, 17026101, 17026111].includes(pId) ||
                      ['pointstplupgrade', 'pointsdiskupgrade'].includes(String(prodType).toLowerCase().trim());

                    const targetDesktopId = parseInt(rConf.desktopId) || parseInt(client.metrics.desktopId) || parseInt(acc.stats?.desktopId) || 0;
                    if (needsDesktop && !targetDesktopId) {
                      this.appendLog('Redeem', `[${acc.name}] 自动兑换跳过: 该商品必须绑定云电脑，但名下未找到有效设备`, 'warning');
                    } else {
                      const buyTimes = Math.max(1, parseInt(rConf.maxRedeemTimes) || 1);
                      const totalCost = Number(rConf.costPoints) * buyTimes;
                      this.appendLog('Redeem', `[${acc.name}] ${reason}，准备自动下单兑换【${rConf.prodName || rConf.prodId}】x${buyTimes}，总计 ${totalCost} 积分...`, 'info');

                      let success = false;
                      let lastMsg = '';
                      let isRisk = false;

                      const orderAttrs = [];
                      if (needsDesktop) {
                        orderAttrs.push({ attrKey: 'bindDesktopId', attrVal: Number(targetDesktopId) });
                      } else {
                        orderAttrs.push({ attrKey: 'mobilephone' });
                      }

                      // 原子总积分下单
                      const payload = {
                        busiChannel: '010',
                        orderType: 1,
                        pointType: Number(rConf.pointType) || 1,
                        points: totalCost,
                        sku: [{
                          execSort: 1,
                          prodId: Number(rConf.prodId),
                          prodType,
                          attrs: orderAttrs
                        }]
                      };

                      for (let attempt = 1; attempt <= 3; attempt++) {
                        try {
                          if (attempt > 1) {
                            this.appendLog('Redeem', `[${acc.name}] 正在进行第 ${attempt}/3 次自动重试...`, 'info');
                            await new Promise(r => setTimeout(r, 3000));
                          }
                          const res = await fetch('https://desk.ctyun.cn/selforder/api/selforder/paas/placeOrder', {
                            method: 'POST',
                            headers: client.getSignedHeaders({ 'Content-Type': 'application/json;charset=UTF-8' }),
                            body: JSON.stringify(payload)
                          });
                          const data = await res.json();
                          if (data.code === 0) {
                            success = true;
                            this.appendLog('Redeem', `[${acc.name}] ✅ 成功一次性完成【${rConf.prodName || rConf.prodId}】x${buyTimes} 自动兑换，共消耗 ${totalCost} 积分！`, 'success');
                            break;
                          }
                          lastMsg = data.msg || `错误码 ${data.code}`;

                          const isFatal = 
                            lastMsg.includes('积分不足') || 
                            lastMsg.includes('点数不足') || 
                            lastMsg.includes('余额不足') ||
                            lastMsg.includes('风控') || 
                            lastMsg.includes('频繁') || 
                            lastMsg.includes('异常操作') ||
                            lastMsg.includes('超过最大') ||
                            lastMsg.includes('上限');

                          if (isFatal) {
                            if (lastMsg.includes('风控') || lastMsg.includes('频繁') || lastMsg.includes('异常操作')) {
                              isRisk = true;
                            }
                            this.appendLog('Redeem', `[${acc.name}] 自动下单触发限制 (${lastMsg})，终止重试。`, 'warning');
                            break;
                          }

                          this.appendLog('Redeem', `[${acc.name}] 第 ${attempt} 次自动兑换未成功: ${lastMsg}`, 'warning');
                        } catch (e) {
                          lastMsg = e.message;
                          this.appendLog('Redeem', `[${acc.name}] 第 ${attempt} 次网络异常: ${lastMsg}`, 'warning');
                        }
                      }

                      if (success) {
                        rConf.lastRedeemDate = todayStr;
                        acc.redeemConfig = rConf;
                        this.saveConfig();
                        this.sendNotification(
                          acc,
                          `🎉 天翼云自动兑换成功 - ${acc.name}`,
                          `策略: ${reason}\n账号【${acc.name}】成功兑换【${rConf.prodName || rConf.prodId}】x${buyTimes}，共消耗 ${totalCost} 积分。`
                        );
                      } else if (isRisk) {
                        this.appendLog('Redeem', `[${acc.name}] 自动兑换触发风控已自动中止: ${lastMsg}`, 'error');
                      } else {
                        this.appendLog('Redeem', `[${acc.name}] 自动兑换失败（已重试 3 次）: ${lastMsg}`, 'error');
                      }
                    }
                  }
                } else if (rConf.lastRedeemDate === todayStr && rConf.prodId) {
                  this.appendLog('Redeem', `[${acc.name}] 今日自动兑换已完成，跳过重复执行。`, 'info');
                }
              } catch (e) {
                this.appendLog('Redeem', `[${acc.name}] 自动兑换执行异常: ${e.message}`, 'error');
              }
            }
          }

          await client.refreshOfficialTasks();
          summaryResults.push(accSummary);

        } catch (err) {
          this.appendLog('Scheduler', `[${acc.name}] 任务执行链路异常: ${err.message}`, 'error');
        }

        if (i < accounts.length - 1) {
          const accountJitterMs = Math.floor(Math.random() * 8000) + 3000;
          this.appendLog('Scheduler', `🛡️ [防风控] 账号间执行退避：随机等待 ${(accountJitterMs / 1000).toFixed(1)} 秒后执行下一个账号...`, 'info');
          await new Promise(r => setTimeout(r, accountJitterMs));
        }
      }

      let allAccountsFullyDone = true;
      for (const acc of accounts) {
        const client = this.getClient(acc);
        const tasks = client?.metrics?.officialTasks || [];
        const loginTask = tasks.find(t => t.name.includes('登录AI云电脑'));
        const aiTask = tasks.find(t => t.name.includes('AI对话'));
        const hangTask = tasks.find(t => t.name.includes('使用1小时'));

        if (this.taskGate(acc, 'sign') && !(loginTask && (loginTask.status === 2 || loginTask.current >= loginTask.total))) {
          allAccountsFullyDone = false;
        }
        if (this.taskGate(acc, 'aiChat') && !(aiTask && (aiTask.status === 2 || aiTask.current >= aiTask.total))) {
          allAccountsFullyDone = false;
        }
        if (this.taskGate(acc, 'cloudHang') && !(hangTask && (hangTask.status === 2 || hangTask.current >= hangTask.total))) {
          allAccountsFullyDone = false;
        }
      }

      if (allAccountsFullyDone) {
        this.lastCompletedDate = todayStr;
        this.appendLog('Scheduler', `🎉 今日云电脑全部自动化任务已圆满达成！做完即标记今日达成，当天绝不再空转。`, 'success');
        const detailText = summaryResults.map(r =>
          `• ${r.name}: 打卡[已达成], AI对话[已达成], 挂机1小时[已满1小时]`
        ).join('\n');
        this.sendNotification(
          this.getSettings(),
          `🎉 天翼云电脑今日任务圆满达成 (${todayStr})`,
          `今日自动化任务已全部达成：\n${detailText}\n所有任务均为原生协议极速直连，零 Chromium 内存占用！`
        );
      } else {
        const anySignPending = summaryResults.some(r => !r.sign);
        const signStatusNote = anySignPending ? '打卡已认领、等待官方确认 (系统会自动复检)' : '打卡已完成';
        this.appendLog('Scheduler', `⚡ 定时任务已执行 (${signStatusNote})。注意：打卡与挂机的最终成败一律以官方任务中心为准。`, 'info');
        const detailText = summaryResults.map(r => {
          const signTxt = r.sign ? '官方已确认达成' : '认领已下发，待官方确认 (自动复检中)';
          const aiTxt = r.aiChat ? '官方已确认达成' : '未确认，请刷新查看';
          const hangTxt = r.hang ? '官方已确认达成' : '尚未达成，后台续跑中';
          return `• ${r.name}: 打卡[${signTxt}], AI对话[${aiTxt}], 挂机1小时[${hangTxt}]`;
        }).join('\n');
        this.sendNotification(
          this.getSettings(),
          `⚡ 天翼云电脑定时任务已触发 (${todayStr})`,
          `定时任务已触发执行，长连接正在后台持续挂机中：\n${detailText}`
        );
      }

      if (this.saveConfig) this.saveConfig();

    } finally {
      this.isRunning = false;
    }
  }
}

module.exports = { TaskScheduler };
