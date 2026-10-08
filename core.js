import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, open, readFile, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const THRESHOLD = 3;
export const PROJECTION_KEY = 'sessionHandoffCompactions';
const RETRY_DELAYS = [5000, 15000, 45000];
const recoveringLocks = new Set();

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
        if (['summarizing', 'prepared'].includes(value.phase)) {
          if (!Number.isSafeInteger(value.sourceSeq) || value.sourceSeq < 0 ||
              typeof value.nextSessionId !== 'string' || !value.nextSessionId ||
              typeof value.messageId !== 'string' || !value.messageId) {
            throw new Error('待恢复交接记录不完整');
          }
          if (value.phase === 'prepared') {
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
    try { await rename(temporary, file); }
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
    const reclaimable = (value) => {
      if (!value) return true;
      let holder;
      try { holder = JSON.parse(value.text); } catch { /* Old versions could leave an empty lock. */ }
      if (Number.isSafeInteger(holder?.pid) && holder.pid > 0) {
        try { process.kill(holder.pid, 0); return false; }
        catch (error) { return error.code === 'ESRCH'; }
      }
      return Date.now() - value.mtimeMs >= 120000;
    };
    const remove = (file) => unlink(file).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    try {
      const handle = await open(temporary, 'wx');
      try {
        await handle.writeFile(JSON.stringify({ pid: process.pid }));
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
        if (!reclaimable(before)) return undefined;
        const current = await snapshot();
        if (!current) {
          if (await publish(path)) return () => remove(path);
          return undefined;
        }
        if (before?.text !== current?.text || before?.mtimeMs !== current?.mtimeMs ||
            before?.ino !== current?.ino || !reclaimable(current)) return undefined;
        await remove(path);
        if (await publish(path)) return () => remove(path);
      } finally { recoveringLocks.delete(path); }
    } finally { await remove(temporary); }
  }
}

export class HandoffCoordinator {
  constructor(host, journal) {
    this.host = host;
    this.journal = journal;
    this.states = new Map();
    this.closed = false;
    this.runs = new Set();
  }
  state(id) {
    if (!this.states.has(id)) this.states.set(id, { phase: 'watching', eligible: null, revision: 0 });
    return this.states.get(id);
  }
  onEvent(session, event) {
    if (this.closed || session.header?.origin === 'subagent' || event.seq < (session.inheritedEventCount ?? 0)) return;
    const state = this.state(session.id);
    if (invalidatesSummary(event)) {
      clearTimeout(state.timer);
      state.timer = undefined;
      state.retryAttempts = 0;
      state.retryAt = undefined;
      state.revision++;
      state.eligible = null;
      state.abort?.abort();
      if (['summarizing', 'error'].includes(state.phase)) state.phase = 'pending';
    }
    if (permitsHandoff(event)) {
      state.eligible = event.seq;
      this.schedule(session.id);
    }
  }
  onIdle(id) { if (this.state(id).eligible !== null) this.schedule(id); }
  recover() {
    const run = this.recoverPending();
    this.runs.add(run);
    run.finally(() => this.runs.delete(run)).catch(() => {});
    return run;
  }
  async recoverPending() {
    const records = await this.journal.pending((message) => this.host.warn(message));
    for (const saved of records) {
      if (this.closed) return;
      const id = saved.sessionId;
      const state = this.state(id);
      if (state.running) continue;
      state.running = true;
      const revision = state.revision;
      const eligible = state.eligible;
      let unlock;
      try {
        unlock = await this.journal.lock(id);
        if (!unlock || this.closed) continue;
        const record = await this.journal.read(id);
        if (!['summarizing', 'prepared'].includes(record?.phase)) continue;
        // A committed target needs no source activation or repeated task execution.
        if (await this.host.hasMessage(record.nextSessionId, record.messageId)) {
          await this.complete(id, record);
          continue;
        }
        const history = await this.host.history(id);
        if (this.closed || history.session?.origin === 'subagent') continue;
        if (state.revision === revision && state.eligible === eligible) {
          state.eligible = latestEligible(history);
        }
        state.phase = 'pending';
        if (state.eligible !== null) await this.host.restore(id);
      } catch (error) {
        state.phase = 'error';
        state.error = error instanceof Error ? error.message : String(error);
        this.host.warn(`session-handoff recovery ${id}: ${state.error}`);
        continue;
      } finally {
        state.running = false;
        await unlock?.();
      }
      if (!this.closed && state.eligible !== null) await this.attempt(id);
    }
  }
  async complete(id, record) {
    const target = this.host.agent(record.nextSessionId) ?? await this.host.restore(record.nextSessionId);
    this.host.wake?.(target);
    await this.host.flush(record.nextSessionId);
    await this.journal.write(id, { ...record, phase: 'done', transferredAt: Date.now() });
    Object.assign(this.state(id), { phase: 'done', error: undefined, retryAt: undefined, retryAttempts: 0 });
  }
  schedule(id, delay = 120) {
    const state = this.state(id);
    if (this.closed || state.timer || state.running) return;
    state.timer = setTimeout(() => {
      state.timer = undefined;
      const run = this.attempt(id);
      this.runs.add(run);
      run.finally(() => this.runs.delete(run)).catch(() => {});
    }, delay);
  }
  async retry(id) {
    if (this.closed) throw new Error('交接插件已停止。');
    const state = this.state(id);
    const status = await this.status(id);
    if (status.phase !== 'error' || state.running) return status;
    clearTimeout(state.timer);
    state.timer = undefined;
    state.retryAt = undefined;
    state.retryAttempts = 0;
    if (state.eligible === null) {
      const revision = state.revision;
      const history = await this.host.history(id);
      if (history.session?.origin === 'subagent') return status;
      if (state.revision === revision) state.eligible = latestEligible(history);
    }
    if (state.eligible !== null) await this.host.restore(id);
    state.phase = 'pending';
    state.error = undefined;
    if (state.eligible !== null) this.schedule(id);
    return this.status(id);
  }
  async status(id) {
    const count = await this.host.count(id);
    const state = this.state(id);
    const journal = await this.journal.read(id);
    const phase = journal?.phase === 'done' ? 'done' : state.phase === 'watching' && count >= THRESHOLD ? 'pending' : state.phase;
    return {
      sessionId: id, count, phase,
      ...(journal?.phase === 'done' ? { nextSessionId: journal.nextSessionId, transferredAt: journal.transferredAt } : {}),
      ...(state.error ? { error: state.error } : {}),
      ...(state.retryAt ? { retryAt: state.retryAt } : {}),
    };
  }
  async attempt(id) {
    const state = this.state(id);
    if (this.closed || state.running || state.eligible === null) return;
    const source = this.host.agent(id);
    if (!source || source.status !== 'idle' || source.inbox.hasPending) return;
    state.running = true;
    const revision = state.revision;
    const sourceSeq = state.eligible;
    const current = () => !this.closed && state.revision === revision && state.eligible === sourceSeq &&
      this.host.agent(id) === source && source.status === 'idle' && !source.inbox.hasPending;
    let unlock;
    let retryDelay;
    try {
      if (await this.host.count(id) < THRESHOLD || !current()) return;
      unlock = await this.journal.lock(id);
      if (!unlock || !current()) return;
      let record = await this.journal.read(id);
      if (record?.phase === 'done') { state.phase = 'done'; return; }
      // Recover the queue/commit crash window without queueing a duplicate task.
      if (record?.nextSessionId && await this.host.hasMessage(record.nextSessionId, record.messageId)) {
        await this.complete(id, record);
        return;
      }
      if (!current()) return;
      state.phase = 'summarizing';
      state.error = undefined;
      state.retryAt = undefined;
      state.abort = new AbortController();
      await source.whenIdle?.();
      if (!current()) return;
      if (record?.phase !== 'prepared' || record.sourceSeq !== sourceSeq) {
        record = { phase: 'summarizing', sourceSeq,
          nextSessionId: record?.nextSessionId ?? `session-${randomUUID()}`,
          messageId: record?.messageId ?? randomUUID() };
        await this.journal.write(id, record);
        if (!current()) return;
      }
      const summary = record?.phase === 'prepared' && record.sourceSeq === sourceSeq
        ? { hasUnfinishedTask: record.hasUnfinishedTask, summary: record.summary }
        : await this.host.summarize(source, state.abort.signal);
      if (!current()) return;
      const title = await this.host.title(source);
      if (!current()) return;
      const attachments = await this.host.attachments?.(source) ?? [];
      if (!current()) return;
      record = {
        phase: 'prepared', sourceSeq,
        nextSessionId: record?.nextSessionId ?? `session-${randomUUID()}`,
        messageId: record?.messageId ?? randomUUID(),
        nextTitle: nextTitle(title, this.host.titleMaxBytes), ...summary, attachments,
      };
      await this.journal.write(id, record);
      if (!current()) return;
      const target = await this.host.create(source, record);
      if (!current()) return;
      // No asynchronous gap between the final source check and enqueue.
      this.host.deliver(target, record);
      await this.complete(id, record);
    } catch (error) {
      if (!current() || state.abort?.signal.aborted) state.phase = 'pending';
      else {
        state.phase = 'error';
        state.error = error instanceof Error ? error.message : String(error);
        if (transientFailure(error) && (state.retryAttempts ?? 0) < RETRY_DELAYS.length) {
          retryDelay = RETRY_DELAYS[state.retryAttempts ?? 0];
          state.retryAttempts = (state.retryAttempts ?? 0) + 1;
          state.retryAt = Date.now() + retryDelay;
        }
        this.host.warn(`session-handoff ${id}: ${state.error}`);
      }
    } finally {
      state.abort = undefined;
      state.running = false;
      await unlock?.();
      if (state.phase === 'summarizing') state.phase = 'pending';
      // A new completed round may have arrived while the cancelled summary settled.
      if (!this.closed && state.eligible !== null && state.eligible !== sourceSeq) this.schedule(id);
      else if (current() && retryDelay !== undefined) this.schedule(id, retryDelay);
    }
  }
  async dispose() {
    this.closed = true;
    for (const state of this.states.values()) { clearTimeout(state.timer); state.abort?.abort(); }
    await Promise.allSettled([...this.runs]);
  }
}
