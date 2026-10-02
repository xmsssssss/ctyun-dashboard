'use strict';

/**
 * ============================================================================
 * 日志落盘器（按日期滚动 + 启动回灌）
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');

const FILE_PREFIX = 'dashboard-';
const FILE_SUFFIX = '.jsonl';
const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_BOOT_LINES = 400;
/** 回灌时单个文件最多从尾部读取的字节数，防止超大文件拖慢启动 */
const TAIL_READ_MAX_BYTES = 2 * 1024 * 1024;

/** 北京时区的 YYYY-MM-DD */
function beijingDateString(d = new Date()) {
  return d.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
}

class LogPersister {
  constructor(opts = {}) {
    this.dir = opts.dir || path.join(process.cwd(), 'logs');
    this.retentionDays = Math.max(1, parseInt(opts.retentionDays, 10) || DEFAULT_RETENTION_DAYS);
    this.onError = typeof opts.onError === 'function' ? opts.onError : () => {};
    this.enabled = false;
    this.currentDate = null;
    this.written = 0;
  }

  /** 初始化：建目录、确定当日文件、清理超期文件。失败则降级为仅内存。 */
  init() {
    try {
      if (!fs.existsSync(this.dir)) fs.mkdirSync(this.dir, { recursive: true });
      this.enabled = true;
      this.currentDate = beijingDateString();
      this.prune();
    } catch (e) {
      this.enabled = false;
      this.onError(`日志落盘初始化失败（已降级为仅内存日志）: ${e.message}`);
    }
    return this.enabled;
  }

  /** 当日日志文件绝对路径 */
  currentFile(dateStr = beijingDateString()) {
    return path.join(this.dir, `${FILE_PREFIX}${dateStr}${FILE_SUFFIX}`);
  }

  /** 追加一条原始日志条目。跨天自动滚动文件并触发清理。 */
  append(entry) {
    if (!this.enabled || !entry) return false;
    try {
      const dateStr = beijingDateString();
      if (dateStr !== this.currentDate) {
        this.currentDate = dateStr;
        this.prune();
      }
      fs.appendFileSync(this.currentFile(dateStr), JSON.stringify(entry) + '\n', 'utf8');
      this.written++;
      return true;
    } catch (e) {
      this.enabled = false;
      this.onError(`日志落盘失败（已降级为仅内存日志）: ${e.message}`);
      return false;
    }
  }

  /** 清理超过保留天数的历史文件 */
  prune() {
    if (!this.enabled) return 0;
    let removed = 0;
    try {
      const cutoff = Date.now() - this.retentionDays * 86400000;
      for (const name of fs.readdirSync(this.dir)) {
        if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) continue;
        const dateStr = name.slice(FILE_PREFIX.length, name.length - FILE_SUFFIX.length);
        const t = Date.parse(`${dateStr}T00:00:00+08:00`);
        if (!Number.isFinite(t)) continue;
        if (t < cutoff) {
          try { fs.unlinkSync(path.join(this.dir, name)); removed++; } catch (e) { /* 忽略 */ }
        }
      }
    } catch (e) {
      this.onError(`日志清理失败: ${e.message}`);
    }
    return removed;
  }

  _listFilesNewestFirst() {
    try {
      return fs.readdirSync(this.dir)
        .filter((n) => n.startsWith(FILE_PREFIX) && n.endsWith(FILE_SUFFIX))
        .sort()
        .reverse()
        .map((n) => path.join(this.dir, n));
    } catch (e) {
      return [];
    }
  }

  _tailLines(file, n) {
    if (n <= 0) return [];
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const size = fs.fstatSync(fd).size;
      if (size <= 0) return [];
      const limit = Math.min(size, TAIL_READ_MAX_BYTES);
      const start = Math.max(0, size - limit);
      const buf = Buffer.alloc(limit);
      fs.readSync(fd, buf, 0, limit, start);
      let text = buf.toString('utf8');
      if (start > 0) {
        const nl = text.indexOf('\n');
        text = nl >= 0 ? text.slice(nl + 1) : '';
      }
      const all = text.split('\n').filter((l) => l.trim());
      return all.slice(-n);
    } catch (e) {
      this.onError(`日志回灌读取失败(${path.basename(file)}): ${e.message}`);
      return [];
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* 已关闭 */ } }
    }
  }

  loadRecent(maxLines = DEFAULT_BOOT_LINES) {
    const need = Math.max(1, parseInt(maxLines, 10) || DEFAULT_BOOT_LINES);
    const chunks = [];
    let got = 0;
    for (const file of this._listFilesNewestFirst()) {
      if (got >= need) break;
      const lines = this._tailLines(file, need - got);
      if (lines.length > 0) {
        chunks.unshift(lines);
        got += lines.length;
      }
    }
    const flat = [];
    for (const c of chunks) flat.push(...c);
    const out = [];
    for (const line of flat.slice(-need)) {
      try {
        const o = JSON.parse(line);
        if (o && typeof o.message === 'string') out.push(o);
      } catch (e) { /* 跳过 */ }
    }
    return out;
  }

  close() {
    this.enabled = false;
  }
}

module.exports = { LogPersister, beijingDateString };
