import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export const THRESHOLD = 3;
export const PROJECTION_KEY = 'sessionHandoffCompactions';
const RETRY_DELAYS = [5000, 15000, 45000];
const recoveringLocks = new Set();
const runFile = promisify(execFile);
let ownProcess;

// PID alone cannot identify an owner after a restart. Query the OS birth time;
// if it is unavailable, keep a live owner's lock rather than guessing by age.
export async function processIdentity(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) return undefined;
  if (pid === process.pid && ownProcess) return ownProcess;
  let identity;
  try {
    if (process.platform === 'win32') {
      const { stdout } = await runFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks.ToString()`],
      { windowsHide: true, timeout: 5000, encoding: 'utf8' });
      const ticks = stdout.trim();
      if (!/^\d+$/u.test(ticks)) return undefined;
      identity = { key: ticks, startedAt: Number(BigInt(ticks) / 10000n - 62135596800000n) };
    } else if (process.platform === 'linux') {
      const [raw, system] = await Promise.all([readFile(`/proc/${pid}/stat`, 'utf8'), readFile('/proc/stat', 'utf8')]);
      const ticks = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
      const boot = /^btime (\d+)$/mu.exec(system)?.[1];
      const { stdout } = await runFile('getconf', ['CLK_TCK'], { timeout: 5000, encoding: 'utf8' });
      if (!ticks || !boot || !(Number(stdout) > 0)) return undefined;
      identity = { key: `${boot}:${ticks}`, startedAt: Number(boot) * 1000 + Number(ticks) / Number(stdout) * 1000 };
    }
  } catch { return undefined; }
  if (pid === process.pid && identity) ownProcess = identity;
  return identity;
}

export function transientFailure(error) {
  const seen = new Set();
  for (let value = error; value && !seen.has(value); value = value.cause) {
    seen.add(value);
    if (['TIMEOUT', 'TRANSPORT', 'SERVER', 'RATE_LIMIT', 'EMPTY_RESPONSE',
      'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH'].includes(value.code) || value.name === 'TimeoutError') return true;
  }
  return false;
}

// UTF-8 byte pricing is deliberately conservative for mixed Chinese/code text.
// Keep both the compacted prefix and the most recent task within the model budget.
export function fitTranscript(text, maxBytes) {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  const note = '\n[中间记录因模型容量省略；不要推测省略的结果]\n';
  const budget = maxBytes - Buffer.byteLength(note);
  if (budget < 0) throw new Error('模型上下文容量不足以生成交接总结。');
  const characters = Array.from(text);
  const take = (items, limit) => {
    const result = [];
    let bytes = 0;
    for (const character of items) {
      bytes += Buffer.byteLength(character);
      if (bytes > limit) break;
      result.push(character);
    }
    return result;
  };
  return take(characters, Math.floor(budget * 0.2)).join('') + note +
    take(characters.reverse(), Math.ceil(budget * 0.8)).reverse().join('');
}

export function summaryTranscript(entries, maxBytes) {
  const full = entries.map(entry => entry.text).join('\n\n');
  if (Buffer.byteLength(full) <= maxBytes) return full;
  const note = '[部分记录因模型容量省略；优先保留最近的用户要求，不要推测省略的结果]\n';
  let remaining = maxBytes - Buffer.byteLength(note);
  const selected = new Map();
  const add = (index, text) => {
    selected.set(index, text);
    remaining -= Buffer.byteLength(text) + 2;
  };
  for (let index = entries.length - 1; index >= 0; index--) {
    if (entries[index].type !== 'user/message') continue;
    const text = entries[index].text;
    if (Buffer.byteLength(text) + 2 > remaining) {
      throw new Error('用户要求或压缩检查点超过当前模型的交接摘要容量，保留原会话。请切换更大上下文模型后重试。');
    }
    add(index, text);
  }
  // Keep the compacted prefix, then spend the rest on recent results.
  if (!selected.has(0) && entries.length && remaining >= 256) {
    add(0, fitTranscript(entries[0].text, Math.min(remaining - 2, Math.max(128, Math.floor(maxBytes * 0.2)))));
  }
  for (let index = entries.length - 1; index >= 0 && remaining >= 256; index--) {
    if (!selected.has(index)) add(index, fitTranscript(entries[index].text, remaining - 2));
  }
  return note + [...selected].sort(([a], [b]) => a - b).map(([, text]) => text).join('\n\n');
}

export function initCount(_header, inheritedEventCount = 0) {
  return { inheritedEventCount, ids: [], count: 0 };
}

export function foldCount(state, event) {
  if (event.seq < state.inheritedEventCount || event.type !== 'compaction/end' ||
      event.data.error != null || typeof event.data.compactionId !== 'string' ||
      state.ids.includes(event.data.compactionId)) return state;
  return { ...state, ids: [...state.ids, event.data.compactionId], count: state.count + 1 };
}

export function fitTitle(title, maxBytes = Infinity) {
  const match = /^(.*?)(?:（续(\d+)）|\(续(\d+)\))\s*$/u.exec(title.trim());
  const suffix = match ? `（续${match[2] ?? match[3]}）` : '';
  let bytes = Buffer.byteLength(suffix);
  if (bytes > maxBytes) throw new Error('会话标题上限不足以保留完整续接编号。');
  let base = '';
  for (const character of (match ? match[1] : title).trim()) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    base += character;
  }
  return base + suffix;
}

export function nextTitle(title, maxBytes = Infinity) {
  const match = /^(.*?)(?:（续(\d+)）|\(续(\d+)\))\s*$/u.exec(title.trim());
  const base = (match ? match[1] : title).trim() || '会话';
  return fitTitle(`${base}（续${match ? Number(match[2] ?? match[3]) + 1 : 1}）`, maxBytes);
}

function invalidatesSummary(event) {
  return event.type === 'turn/start' || event.type === 'user/message' ||
    (event.type === 'agent/inbox/spliced' && event.data.inserted?.length);
}

function permitsHandoff(event) {
  return (event.type === 'turn/end' && ['completed', 'max-tokens'].includes(event.data.reason?.kind)) ||
    (event.type === 'compaction/end' && event.data.turn === null && event.data.error == null);
}

function latestEligible(history) {
  let eligible = null;
  for (const event of history.events) {
    if (event.seq < (history.inheritedEventCount ?? 0)) continue;
    if (invalidatesSummary(event)) eligible = null;
    if (permitsHandoff(event)) eligible = event.seq;
  }
  return eligible;
}

export function parseSummary(text) {
  const clean = text.trim().replace(/^```(?:json)?\s*/u, '').replace(/\s*```$/u, '');
  let result;
  try { result = JSON.parse(clean); } catch { throw new Error('交接总结没有返回完整 JSON，保留原会话。'); }
  if (typeof result.hasUnfinishedTask !== 'boolean' || typeof result.summary !== 'string' ||
      result.summary.trim().length < 8 || result.summary.length > 50000) {
    throw new Error('交接总结缺少任务状态或有效内容，保留原会话。');
  }
  return { hasUnfinishedTask: result.hasUnfinishedTask, summary: result.summary.trim() };
}

// Each source owns one small durable journal and one OS-exclusive lock. The
// committed Session message remains the authority for whether work was queued.
export class Journal {
  constructor(directory) { this.directory = directory; }
  path(id, suffix = '.json') {
    return join(this.directory, createHash('sha256').update(id).digest('hex') + suffix);
  }
  async read(id) {
    try {
      const value = JSON.parse(await readFile(this.path(id), 'utf8'));
      if (value.sessionId !== id || value.version !== 1) throw new Error('交接记录格式不匹配');
      return value;
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }
  async pending(warn) {
    let files;
    try { files = await readdir(this.directory); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    const records = [];
    for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/u.test(name))) {
      try {
        const value = JSON.parse(await readFile(join(this.directory, file), 'utf8'));
        if (value.version !== 1 || typeof value.sessionId !== 'string' ||
            this.path(value.sessionId) !== join(this.directory, file)) throw new Error('交接记录格式不匹配');
        if (['summarizing', 'prepared', 'committing', 'done', 'error'].includes(value.phase)) {
          if (!Number.isSafeInteger(value.sourceSeq) || value.sourceSeq < 0 ||
              typeof value.nextSessionId !== 'string' || !value.nextSessionId ||
              typeof value.messageId !== 'string' || !value.messageId) {
            throw new Error('待恢复交接记录不完整');
          }
          if (['prepared', 'committing', 'done'].includes(value.phase) || value.resumePhase === 'committing') {
            if (typeof value.nextTitle !== 'string') throw new Error('待恢复交接记录缺少标题');
            parseSummary(JSON.stringify(value));
          }
          records.push(value);
        }
      } catch (error) { warn(`session-handoff recovery ${file}: ${error.message}`); }
    }
    return records;
  }
  async write(id, value) {
    await mkdir(this.directory, { recursive: true });
    const file = this.path(id);
    const temporary = `${file}.${randomUUID()}.tmp`;
    const handle = await open(temporary, 'wx');
    try { await handle.writeFile(JSON.stringify({ ...value, version: 1, sessionId: id }), 'utf8'); await handle.sync(); }
    finally { await handle.close(); }
    try {
      for (let attempt = 0; ; attempt++) {
        try { await rename(temporary, file); break; }
        catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 3) throw error;
          await new Promise(resolve => setTimeout(resolve, [10, 30, 90][attempt]));
        }
      }
    }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async lock(id) {
    await mkdir(this.directory, { recursive: true });
    const path = this.path(id, '.lock');
    const temporary = `${path}.${randomUUID()}.tmp`;
    const publish = async (file) => {
      try { await link(temporary, file); return true; }
      catch (error) { if (error.code === 'EEXIST') return false; throw error; }
    };
    const snapshot = async () => {
      let text, metadata;
      try {
        [text, metadata] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
      } catch (error) {
        if (error.code === 'ENOENT') return undefined;
        throw error;
      }
      return { text, mtimeMs: metadata.mtimeMs, ino: metadata.ino };
    };
    const reclaimable = async (value) => {
      if (!value) return true;
      let holder;
      try { holder = JSON.parse(value.text); } catch { /* Old versions could leave an empty lock. */ }
      if (Number.isSafeInteger(holder?.pid) && holder.pid > 0) {
        try { process.kill(holder.pid, 0); }
        catch (error) { return error.code === 'ESRCH'; }
        const identity = await processIdentity(holder.pid);
        if (!identity) return false;
        return typeof holder.processKey === 'string' ? holder.processKey !== identity.key
          : identity.startedAt > value.mtimeMs + 1000;
      }
      return Date.now() - value.mtimeMs >= 120000;
    };
    const remove = (file) => unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    try {
      const handle = await open(temporary, 'wx');
      try {
        const identity = await processIdentity(process.pid);
        await handle.writeFile(JSON.stringify({ pid: process.pid, ...(identity ? { processKey: identity.key } : {}) }));
        await handle.sync();
      } finally { await handle.close(); }
      // The public lock is always complete: a crash during write leaves only an
      // unreferenced temporary file, never an empty lock blocking the next run.
      if (await publish(path)) return () => remove(path);
      if (recoveringLocks.has(path)) return undefined;
      recoveringLocks.add(path);
      try {
        // DSH owns one host per profile; serialise its windows' recovery here.
        // The file is advisory across independent hosts, which DSH does not
        // permit for one profile. Re-check before removing a legacy stale lock.
        const before = await snapshot();
        if (!before) {
          if (await publish(path)) return () => remove(path);
          return undefined;
        }
        if (!await reclaimable(before)) return undefined;
        const current = await snapshot();
        if (!current) {
          if (await publish(path)) return () => remove(path);
          return undefined;
        }
        if (before?.text !== current?.text || before?.mtimeMs !== current?.mtimeMs ||
            before?.ino !== current?.ino || !await reclaimable(current)) return undefined;
        await remove(path);
        if (await publish(path)) return () => remove(path);
      } finally { recoveringLocks.delete(path); }
    } finally { await remove(temporary); }
  }
}

// Recover claimed input as well as queued input: a crash can happen between the
// native inbox claim and our pre-step hook. Explicitly canceled input stays canceled.
export function forwardedInput(history, record) {
  const messages = new Map();
  const queues = { 'next-turn': [], 'next-step': [] };
  for (const event of history.events) {
    if (event.seq <= (record.forwardAfterSeq ?? record.sourceSeq)) continue;
    if (event.type === 'agent/inbox/spliced') {
      const data = event.data;
      const queue = queues[data.target];
      if (!queue) continue;
      const removed = queue.splice(data.start, data.removedCount ?? 0, ...(data.inserted ?? []));
      if (data.outcome === 'canceled') for (const message of removed) messages.delete(message.id);
      for (const message of data.inserted ?? []) messages.set(message.id, message);
    } else if (event.type === 'user/message') messages.set(event.data.id, event.data);
  }
  return [...messages.values()].filter(message => message.id && message.source?.kind !== 'goal');
}

export class HandoffCoordinator {
  constructor(host, journal) {
    this.host = host;
    this.journal = journal;
    this.states = new Map();
    this.closed = false;
    this.runs = new Set();
    host.bind?.(this);
  }
  state(id) {
    if (!this.states.has(id)) this.states.set(id, { phase: 'watching', eligible: null, revision: 0 });
    return this.states.get(id);
  }
  track(run) {
    this.runs.add(run);
    run.finally(() => this.runs.delete(run)).catch(() => {});
    return run;
  }
  onEvent(session, event) {
    if (this.closed || event.seq < (session.inheritedEventCount ?? 0)) return;
    if (session.header?.origin === 'subagent') {
      const root = this.host.rootId?.(session.id);
      if (root && root !== session.id && (invalidatesSummary(event) || permitsHandoff(event))) {
        const state = this.state(root);
        state.revision++;
        state.abort?.abort();
        if (state.eligible !== null) this.schedule(root);
      }
      return;
    }
    const state = this.state(session.id);
    // Ownership changes once, before enqueue. Later input is routed by pre-step
    // to the continuation instead of starting a second worker in this source.
    if (state.ownership) return;
    const goalChanged = event.type === 'goal/change';
    if (invalidatesSummary(event) || goalChanged) {
      clearTimeout(state.timer);
      state.timer = undefined;
      state.retryAttempts = 0;
      state.retryAt = undefined;
      state.revision++;
      if (!goalChanged) state.eligible = null;
      state.abort?.abort();
      if (['summarizing', 'error', 'deferred'].includes(state.phase)) state.phase = 'pending';
    }
    if (permitsHandoff(event)) state.eligible = event.seq;
    if (permitsHandoff(event) || goalChanged) this.schedule(session.id);
  }
  onIdle(id) {
    id = this.host.rootId?.(id) ?? id;
    if (this.state(id).eligible !== null) this.schedule(id);
  }
  onRelatedActivity(id) {
    id = this.host.rootId?.(id) ?? id;
    const state = this.state(id);
    if (state.ownership) return;
    state.revision++;
    state.abort?.abort();
    if (state.eligible !== null) this.schedule(id);
  }
  recover() { return this.track(this.recoverPending()); }
  async recoverPending() {
    const records = await this.journal.pending(message => this.host.warn(message));
    // Prepared work is cheap and ready. Two independent sources may recover at
    // once; a slow summary cannot hold every other session behind it.
    records.sort((a, b) => Number(a.phase === 'summarizing') - Number(b.phase === 'summarizing'));
    let cursor = 0;
    await Promise.all(Array.from({ length: Math.min(2, records.length) }, async () => {
      while (!this.closed && cursor < records.length) await this.recoverOne(records[cursor++]);
    }));
  }
  async recoverOne(saved) {
    const id = saved.sessionId;
    // Old completed journals predate routing. Never replay their later work.
    if (saved.phase === 'done' && !saved.routing) return;
    const state = this.state(id);
    if (state.running) return;
    state.running = true;
    const settled = state.settled = Promise.withResolvers();
    let unlock;
    try {
      unlock = await this.journal.lock(id);
      if (!unlock || this.closed) return;
      const record = await this.journal.read(id);
      if (!record) return;
      state.paused = record.paused === true;
      state.stopRequested = record.stopped === true;
      state.retryAttempts = record.retryAttempts ?? 0;
      if (record.phase === 'done' || record.phase === 'committing' || record.resumePhase === 'committing') state.ownership = record;
      if (record.phase === 'error') {
        Object.assign(state, { phase: 'error', error: record.error, retryAt: record.retryAt });
        if (!record.retryAt || state.paused) return;
      } else if (state.paused) { state.phase = 'paused'; return; }
      if (record.phase === 'done') {
        const history = await this.host.history(id);
        const pending = [];
        for (const message of forwardedInput(history, record)) {
          if (!await this.host.hasMessage(record.nextSessionId, message.id)) pending.push(message);
        }
        if (pending.length) await this.complete(id, record, pending);
        else state.phase = 'done';
        return;
      }
      // An already queued handoff owns the source even if its final journal
      // flush failed. Do not resummarize or deliver a second task.
      if (record.phase !== 'error' && (record.phase === 'committing' ||
          await this.host.hasMessage(record.nextSessionId, record.messageId))) {
        await this.complete(id, record);
        return;
      }
      const history = await this.host.history(id);
      if (this.closed || history.session?.origin === 'subagent') return;
      if (state.eligible === null) state.eligible = latestEligible(history);
      if (state.eligible !== null) await this.host.restore(id);
      if (record.phase !== 'error') state.phase = 'pending';
    } catch (error) {
      await this.fail(id, saved, error);
    } finally {
      state.running = false;
      await unlock?.();
      settled.resolve();
    }
    if (!this.closed && !state.paused && (state.eligible !== null || state.ownership)) {
      if (state.retryAt > Date.now()) this.schedule(id, state.retryAt - Date.now());
      else await this.attempt(id);
    }
  }
  async complete(id, record, pending) {
    const state = this.state(id);
    state.ownership = record;
    if (record.stopped) state.stopRequested = true;
    const check = () => {
      if (this.closed) throw Object.assign(new Error('交接插件已停止。'), { code: 'HANDOFF_DISPOSED' });
      if (state.stopRequested) throw Object.assign(new Error('用户已停止交接，请手动重试后继续。'), { code: 'HANDOFF_STOPPED' });
    };
    check();
    let target = this.host.agent(record.nextSessionId);
    if (!target) {
      try { target = await this.host.restore(record.nextSessionId); }
      catch (error) {
        if (!['SESSION_QUERY_SESSION_NOT_FOUND', 'SESSION_PERSISTENCE_NOT_FOUND', 'session/not-found'].includes(error.code)) throw error;
        target = await this.host.create(this.host.agent(id) ?? await this.host.restore(id), record);
      }
    }
    check();
    const delivered = await this.host.hasMessage(record.nextSessionId, record.messageId);
    check();
    if (!delivered) this.host.deliver(target, record);
    check();
    this.host.wake?.(target);
    await this.host.flush(record.nextSessionId);
    check();
    if (record.routing && this.host.forward) {
      pending ??= forwardedInput(await this.host.history(id), record);
      for (const message of pending) {
        const exists = await this.host.hasMessage(record.nextSessionId, message.id);
        check();
        if (!exists) this.host.forward(target, message);
      }
      await this.host.flush(record.nextSessionId);
      check();
    }
    const committed = { ...record, phase: 'done', routing: record.routing === true,
      transferredAt: record.transferredAt ?? Date.now(), error: undefined, resumePhase: undefined,
      retryAt: undefined, retryAttempts: 0 };
    await this.journal.write(id, committed);
    check();
    Object.assign(state, { ownership: committed, phase: 'done', error: undefined, retryAt: undefined, retryAttempts: 0 });
  }
  schedule(id, delay = 120) {
    const state = this.state(id);
    if (this.closed || state.timer || state.running || state.paused || state.phase === 'done') return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      this.track(this.attempt(id));
    }, delay);
  }
  async retry(id) {
    if (this.closed) throw new Error('交接插件已停止。');
    const state = this.state(id);
    const status = await this.status(id);
    if (status.phase !== 'error' || state.running) return status;
    clearTimeout(state.timer);
    state.timer = undefined;
    const record = await this.journal.read(id);
    state.retryAt = undefined;
    state.retryAttempts = 0;
    state.stopRequested = false;
    if (record) await this.journal.write(id, { ...record, phase: record.resumePhase ?? 'summarizing',
      retryAt: undefined, retryAttempts: 0, error: undefined, resumePhase: undefined, stopped: false });
    if (state.eligible === null && !state.ownership) {
      const revision = state.revision;
      const history = await this.host.history(id);
      if (history.session?.origin === 'subagent') return status;
      if (state.revision === revision) state.eligible = latestEligible(history);
    }
    if (state.eligible !== null) await this.host.restore(id);
    state.phase = 'pending';
    state.error = undefined;
    if (state.eligible !== null || state.ownership) this.schedule(id);
    return this.status(id);
  }
  async pause(id, paused) {
    if (this.closed) throw new Error('交接插件已停止。');
    const state = this.state(id);
    if (state.ownership) return this.status(id);
    state.paused = paused;
    clearTimeout(state.timer);
    state.timer = undefined;
    if (paused) state.abort?.abort();
    await state.settled?.promise;
    const unlock = await this.journal.lock(id);
    if (!unlock) throw new Error('交接设置正在保存，请稍后重试。');
    try {
      const record = await this.journal.read(id);
      if (['done', 'committing'].includes(record?.phase)) return this.status(id);
      await this.journal.write(id, { ...record, phase: record?.phase ?? 'watching', paused });
      if (!paused) {
        if (state.eligible === null) state.eligible = latestEligible(await this.host.history(id));
        if (state.eligible !== null) await this.host.restore(id);
        state.phase = record?.phase === 'error' ? 'error' : await this.host.count(id) >= THRESHOLD ? 'pending' : 'watching';
        state.retryAt = record?.phase === 'error' ? record.retryAt : undefined;
      } else state.phase = 'paused';
    } finally { await unlock(); }
    if (!paused && (state.phase !== 'error' || state.retryAt)) this.schedule(id, state.retryAt ? Math.max(0, state.retryAt - Date.now()) : 120);
    return this.status(id);
  }
  async status(id) {
    const count = await this.host.count(id);
    const state = this.state(id);
    const record = await this.journal.read(id);
    if (state.paused === undefined) state.paused = record?.paused === true;
    const phase = record?.phase === 'done' ? 'done' : state.paused ? 'paused'
      : state.phase === 'watching' && record?.phase === 'error' ? 'error'
      : state.phase === 'watching' && count >= THRESHOLD ? 'pending' : state.phase;
    return { sessionId: id, count, phase,
      canPause: !state.ownership && !['done', 'committing'].includes(record?.phase) && record?.resumePhase !== 'committing',
      ...(record?.phase === 'done' ? { nextSessionId: record.nextSessionId, transferredAt: record.transferredAt } : {}),
      ...(phase === 'error' && (state.error ?? record?.error) ? { error: state.error ?? record.error } : {}),
      ...(phase === 'error' && (state.retryAt ?? record?.retryAt) ? { retryAt: state.retryAt ?? record.retryAt } : {}),
      ...(state.reason ? { reason: state.reason } : {}),
    };
  }
  async fail(id, record, error) {
    const state = this.state(id);
    if (record?.stopped || error?.code === 'HANDOFF_STOPPED') state.stopRequested = true;
    const message = state.stopRequested ? '用户已停止交接，请手动重试后继续。' : error instanceof Error ? error.message : String(error);
    let attempts = state.retryAttempts ?? record?.retryAttempts ?? 0;
    const delay = !state.stopRequested && transientFailure(error) && attempts < RETRY_DELAYS.length ? RETRY_DELAYS[attempts++] : undefined;
    const retryAt = delay === undefined ? undefined : Date.now() + delay;
    Object.assign(state, { phase: 'error', error: message, retryAttempts: attempts, retryAt });
    if (record?.nextSessionId) {
      await this.journal.write(id, { ...record, phase: 'error',
        resumePhase: state.ownership ? 'committing' : record.resumePhase ?? record.phase,
        error: message, retryAttempts: attempts, retryAt, paused: state.paused === true,
        stopped: state.stopRequested === true });
    }
    this.host.warn(`session-handoff ${id}: ${message}`);
    if (retryAt) this.schedule(id, Math.max(0, retryAt - Date.now()));
  }
  async attempt(id) {
    const state = this.state(id);
    if (this.closed || state.running || state.paused || (state.eligible === null && !state.ownership)) return;
    const source = this.host.agent(id);
    if (!state.ownership && (!source || source.status !== 'idle' || source.inbox.hasPending)) return;
    state.running = true;
    state.settled = Promise.withResolvers();
    const revision = state.revision;
    const sourceSeq = state.eligible;
    const current = () => !this.closed && !state.paused && state.revision === revision && state.eligible === sourceSeq &&
      this.host.agent(id) === source && source.status === 'idle' && !source.inbox.hasPending && !this.host.guard?.(source);
    let unlock;
    let record;
    try {
      unlock = await this.journal.lock(id);
      if (!unlock || this.closed) return;
      record = await this.journal.read(id);
      if (record?.paused) { state.paused = true; return; }
      if (record?.phase === 'error' && record.sourceSeq === sourceSeq || record?.resumePhase === 'committing') {
        state.retryAttempts = record.retryAttempts ?? 0;
        if (!record.retryAt) { state.phase = 'error'; state.error = record.error; return; }
        if (record.retryAt > Date.now()) { state.retryAt = record.retryAt; return; }
      }
      if (record?.phase === 'done') { state.ownership = record; state.phase = 'done'; return; }
      if (state.ownership || record?.phase === 'committing' || (record?.nextSessionId &&
          await this.host.hasMessage(record.nextSessionId, record.messageId))) {
        await this.complete(id, record);
        return;
      }
      const reason = this.host.guard?.(source);
      if (reason) { state.phase = 'deferred'; state.reason = reason; return; }
      if (await this.host.count(id) < THRESHOLD || !current()) return;
      Object.assign(state, { phase: 'summarizing', error: undefined, reason: undefined, retryAt: undefined });
      state.abort = new AbortController();
      await source.whenIdle?.();
      if (!current()) return;
      const resume = record?.phase === 'error' ? record.resumePhase : record?.phase;
      const reuseSummary = resume === 'prepared' && record.sourceSeq === sourceSeq;
      if (!reuseSummary) {
        record = { phase: 'summarizing', sourceSeq, retryAttempts: state.retryAttempts ?? 0,
          nextSessionId: record?.nextSessionId ?? `session-${randomUUID()}`,
          messageId: record?.messageId ?? randomUUID() };
        await this.journal.write(id, record);
        if (!current()) return;
      }
      const summary = reuseSummary
        ? { hasUnfinishedTask: record.hasUnfinishedTask, summary: record.summary }
        : await this.host.summarize(source, state.abort.signal);
      if (!current()) return;
      const title = await this.host.title(source);
      if (!current()) return;
      const attachments = await this.host.attachments?.(source) ?? [];
      if (!current()) return;
      record = { phase: 'prepared', sourceSeq, retryAttempts: state.retryAttempts ?? 0,
        nextSessionId: record.nextSessionId, messageId: record.messageId,
        nextTitle: nextTitle(title, this.host.titleMaxBytes), ...summary, attachments };
      await this.journal.write(id, record);
      if (!current()) return;
      const target = await this.host.create(source, record);
      if (!current()) return;
      state.ownership = record;
      state.phase = 'committing';
      record = { ...record, phase: 'committing', routing: true };
      try { await this.journal.write(id, record); }
      catch (error) { state.ownership = undefined; throw error; }
      // Once this durable ownership record exists, all later input follows it.
      this.host.deliver(target, record);
      await this.complete(id, record);
    } catch (error) {
      if (this.closed) return;
      if (!state.ownership && (!current() || state.abort?.signal.aborted)) state.phase = 'pending';
      else await this.fail(id, record, error);
    } finally {
      state.abort = undefined;
      state.running = false;
      await unlock?.();
      state.settled.resolve();
      if (state.phase === 'summarizing') state.phase = 'pending';
      if (!this.closed && state.eligible !== null && state.eligible !== sourceSeq) this.schedule(id);
      else if (!this.closed && state.retryAt && !state.paused) this.schedule(id, Math.max(0, state.retryAt - Date.now()));
    }
  }
  // Native pre-step calls this before an old source can make another request.
  forward(id, messages, signal) { return this.track(this.forwardPending(id, messages, signal)); }
  watchStop(id, signal) {
    const state = this.state(id);
    const stop = () => {
      if (signal.reason?.kind !== 'user') return;
      state.stopRequested = true;
      const target = this.host.agent(state.ownership?.nextSessionId);
      if (target) this.host.cancel?.(target);
    };
    signal.addEventListener('abort', stop, { once: true });
    if (signal.aborted) stop();
    return () => signal.removeEventListener('abort', stop);
  }
  migrateLegacy(source, note, messages, signal) {
    return this.track(this.migrateLegacyNote(source, note, messages, signal));
  }
  async migrateLegacyNote(source, note, messages, signal) {
    const reason = this.host.guard?.(source);
    if (reason) throw new Error(reason === 'goal' ? '此旧版会话需要先完成或清除 Goal，再继续交接。' : '此旧版会话需要先等待子代理结束，再继续交接。');
    const id = source.id, state = this.state(id);
    if (state.ownership?.routing) return this.forward(id, messages, signal);
    state.running = true;
    state.settled = Promise.withResolvers();
    let record, unlock, unwatch;
    try {
      unlock = await this.journal.lock(id);
      if (!unlock) throw new Error('旧版会话交接正在恢复，请稍后重试。');
      record = await this.journal.read(id);
      if (record?.stopped) throw Object.assign(new Error('用户已停止交接，请手动重试后继续。'), { code: 'HANDOFF_STOPPED' });
      if (!record?.routing) {
        const history = await this.host.history(id);
        const noteEvent = history.events.find(event => event.type === 'user/message' && event.data.id === note.id);
        if (!noteEvent) throw new Error('旧版交接记录缺少原始消息边界，保留原会话。');
        record = { phase: 'committing', routing: true,
          sourceSeq: history.events.at(-1).seq, forwardAfterSeq: noteEvent.seq,
          nextSessionId: `session-${randomUUID()}`, messageId: randomUUID(),
          nextTitle: nextTitle(await this.host.title(source), this.host.titleMaxBytes),
          hasUnfinishedTask: false,
          summary: note.content.filter(block => block.type === 'text').map(block => block.text).join('\n'),
          attachments: await this.host.attachments(source), legacyMigration: true };
      }
      state.ownership = record;
      state.phase = 'committing';
      unwatch = this.watchStop(id, signal);
      await this.journal.write(id, record);
      await this.host.recordInput(source, messages);
      await this.host.flush(id);
      await this.host.create(source, record);
      await this.complete(id, record);
      return true;
    } catch (error) {
      if (!this.closed) await this.fail(id, record, error);
      throw error;
    } finally {
      unwatch?.();
      state.running = false;
      await unlock?.();
      state.settled.resolve();
      if (!this.closed && state.retryAt) this.schedule(id, Math.max(0, state.retryAt - Date.now()));
    }
  }
  async forwardPending(id, messages, signal) {
    if (!messages.length || this.closed) return false;
    const state = this.state(id);
    let record = await this.journal.read(id);
    if (!state.ownership && !record?.routing) return false;
    if (!state.ownership && !['committing', 'done'].includes(record?.phase) && record?.resumePhase !== 'committing') return false;
    state.ownership ??= record;
    const unwatch = this.watchStop(id, signal);
    let unlock;
    try {
      if (state.running) await state.settled?.promise;
      record = await this.journal.read(id);
      if (!record?.routing || !['committing', 'done'].includes(record?.phase) && record?.resumePhase !== 'committing') return false;
      if (record.stopped || state.stopRequested) throw Object.assign(new Error('用户已停止交接，请手动重试后继续。'), { code: 'HANDOFF_STOPPED' });
      if (messages.some(message => message.source?.kind === 'goal')) throw new Error('原会话已交接，请在续接会话管理 Goal。');
      signal.throwIfAborted();
      // Store original input before enqueueing elsewhere. Native IDs also make
      // a crash between claim, source flush and target flush recoverable.
      await this.host.recordInput(this.host.agent(id), messages);
      await this.host.flush(id);
      unlock = await this.journal.lock(id);
      if (!unlock) throw Object.assign(new Error('交接正在恢复，消息已保留，请稍后重试。'), { code: 'TRANSPORT' });
      record = await this.journal.read(id);
      await this.complete(id, record);
      return true;
    } catch (error) {
      if (!this.closed) await this.fail(id, record ?? state.ownership, error);
      throw error;
    } finally { unwatch(); await unlock?.(); }
  }
  async dispose() {
    this.closed = true;
    for (const state of this.states.values()) { clearTimeout(state.timer); state.abort?.abort(); }
    await Promise.allSettled([...this.runs]);
  }
}
