import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import fsPromises from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { HandoffCoordinator, Journal, initCount, foldCount, nextTitle, fitTitle, parseSummary, transientFailure, fitTranscript, summaryTranscript } from './core.js';

const end = (seq, kind = 'completed') => ({ seq, type: 'turn/end', data: { reason: { kind } } });
const compact = (seq, id, error) => ({ seq, type: 'compaction/end', data: { compactionId: id, turn: 1, ...(error ? { error } : {}) } });

test('successful unique own compactions only; new session resets; titles continue', () => {
  const events = [compact(0, 'inherited'), compact(2, 'a'), compact(3, 'a'), compact(4, 'bad', ['error']),
    { seq: 5, type: 'tool/result', data: {} }, compact(6, 'b'), compact(7, 'c')];
  assert.equal(events.reduce(foldCount, initCount({}, 2)).count, 3);
  assert.equal(initCount({}).count, 0);
  assert.equal(nextTitle('DSH 插件开发'), 'DSH 插件开发（续1）');
  assert.equal(nextTitle('DSH 插件开发（续9）'), 'DSH 插件开发（续10）');
  assert.equal(parseSummary('{"hasUnfinishedTask":false,"summary":"任务全部完成，等待用户。"}').hasUnfinishedTask, false);
  assert.throws(() => parseSummary('{"hasUnfinishedTask":"false","summary":"任务全部完成"}'));
});

async function harness(t, overrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-test-'));
  const source = { id: 'source', status: 'idle', inbox: { hasPending: false }, session: {}, header: {} };
  const session = { id: 'source', inheritedEventCount: 0, header: {} };
  const targets = new Map();
  const deliveries = [];
  const warnings = [];
  let summaries = 0;
  const host = {
    agent: (id) => id === source.id ? source : targets.get(id), count: async () => 3,
    summarize: async () => { summaries++; return { hasUnfinishedTask: true, summary: '已完成分析，接下来完成实施和验证。' }; },
    title: async () => '测试任务（续2）',
    hasMessage: async (id, messageId) => deliveries.some((item) => item.id === id && item.messageId === messageId),
    create: async (_source, record) => {
      if (!targets.has(record.nextSessionId)) targets.set(record.nextSessionId, { id: record.nextSessionId });
      return targets.get(record.nextSessionId);
    },
    deliver: (target, record) => deliveries.push({ id: target.id, ...record }),
    flush: async () => {}, warn: (message) => warnings.push(message), ...overrides,
  };
  host.history ??= async () => ({ events: [end(10)], inheritedEventCount: 0 });
  host.restore ??= async () => source;
  const journal = new Journal(dir);
  const coordinator = new HandoffCoordinator(host, journal);
  t.after(async () => { await coordinator.dispose(); await rm(dir, { recursive: true, force: true }); });
  function eligible(seq = 10, kind = 'completed') {
    coordinator.onEvent(session, end(seq, kind));
    clearTimeout(coordinator.state('source').timer); coordinator.state('source').timer = undefined;
  }
  return { host, source, session, targets, deliveries, warnings, journal, coordinator, eligible, summaries: () => summaries };
}

test('startup status is read-only, running and queued inputs defer; successful handoff once', async (t) => {
  const h = await harness(t);
  assert.equal((await h.coordinator.status('source')).phase, 'pending');
  await h.coordinator.attempt('source');
  assert.equal(h.summaries(), 0);
  h.eligible(); h.source.status = 'running';
  await h.coordinator.attempt('source'); assert.equal(h.targets.size, 0);
  h.source.status = 'idle'; h.source.inbox.hasPending = true;
  await h.coordinator.attempt('source'); assert.equal(h.targets.size, 0);
  h.source.inbox.hasPending = false;
  await Promise.all([h.coordinator.attempt('source'), h.coordinator.attempt('source')]);
  assert.equal(h.deliveries.length, 1); assert.equal(h.deliveries[0].nextTitle, '测试任务（续3）');
  h.eligible(20); await h.coordinator.attempt('source');
  assert.equal(h.deliveries.length, 1);
  assert.equal((await h.coordinator.status('source')).phase, 'done');
});

test('new user input during summary prevents stale transfer and resumes after later reply', async (t) => {
  let release;
  const h = await harness(t, { summarize: () => new Promise((resolve) => { release = resolve; }) });
  h.eligible(); const run = h.coordinator.attempt('source');
  while (!release) await new Promise((resolve) => setTimeout(resolve, 2));
  h.coordinator.onEvent(h.session, { seq: 11, type: 'agent/inbox/spliced', data: { inserted: [{ id: 'new-user' }] } });
  release({ hasUnfinishedTask: true, summary: '旧任务尚未完成，继续下一步。' });
  await run; assert.equal(h.targets.size, 0); assert.equal(h.deliveries.length, 0);
  h.host.summarize = async () => ({ hasUnfinishedTask: false, summary: '新要求已经完成，保持空闲。' });
  h.eligible(20); await h.coordinator.attempt('source');
  assert.equal(h.deliveries.length, 1); assert.equal(h.deliveries[0].hasUnfinishedTask, false);
});

test('failed or aborted turns never trigger, summarization failure preserves old session', async (t) => {
  const h = await harness(t, { summarize: async () => { throw new Error('provider offline'); } });
  h.eligible(10, 'error'); await h.coordinator.attempt('source'); assert.equal(h.warnings.length, 0);
  h.eligible(11, 'aborted'); await h.coordinator.attempt('source'); assert.equal(h.warnings.length, 0);
  h.eligible(12, 'max-tokens'); await h.coordinator.attempt('source');
  assert.equal(h.targets.size, 0); assert.equal(h.warnings.length, 1);
  assert.equal((await h.coordinator.status('source')).phase, 'error');
});

test('restart after queue-before-journal commit recovers without duplicate delivery', async (t) => {
  let failFlush = true;
  const h = await harness(t, { flush: async () => { if (failFlush) throw new Error('disk temporarily unavailable'); } });
  h.eligible(); await h.coordinator.attempt('source');
  assert.equal(h.deliveries.length, 1); assert.equal((await h.journal.read('source')).phase, 'prepared');
  failFlush = false;
  const restarted = new HandoffCoordinator(h.host, h.journal);
  await restarted.recover();
  assert.equal(h.deliveries.length, 1); assert.equal((await restarted.status('source')).phase, 'done');
  await restarted.dispose();
});

test('startup recovers only prepared journals and reuses a current durable summary', async (t) => {
  const h = await harness(t);
  await h.journal.write('source', { phase: 'prepared', sourceSeq: 10,
    nextSessionId: 'recover-target', messageId: 'recover-message', nextTitle: '测试（续3）',
    hasUnfinishedTask: true, summary: '已保存的任务总结，继续实施并验证。' });
  await h.coordinator.recover();
  assert.equal(h.summaries(), 0, 'a valid saved summary must work without another model call');
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].messageId, 'recover-message');
  assert.equal((await h.journal.read('source')).phase, 'done');
  await h.coordinator.recover();
  assert.equal(h.deliveries.length, 1);
});

test('startup commits an already delivered message without loading the old source', async (t) => {
  const restored = [];
  const h = await harness(t, {
    restore: async (id) => { assert.equal(id, 'existing-target'); restored.push(id); },
    history: async () => { throw new Error('source must not be inspected'); },
  });
  const record = { phase: 'prepared', sourceSeq: 10, nextSessionId: 'existing-target',
    messageId: 'existing-message', nextTitle: '测试（续3）', hasUnfinishedTask: false, summary: '任务完成，保存记录。' };
  await h.journal.write('source', record);
  h.deliveries.push({ id: record.nextSessionId, ...record });
  await h.coordinator.recover();
  assert.equal((await h.journal.read('source')).phase, 'done');
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.warnings.length, 0);
  assert.deepEqual(restored, ['existing-target']);
});

test('a crash during summarization is journaled and recovered on the next startup', async (t) => {
  let release;
  const h = await harness(t, { summarize: () => new Promise((resolve) => { release = resolve; }) });
  h.eligible();
  const interrupted = h.coordinator.attempt('source');
  while (!release) await new Promise((resolve) => setTimeout(resolve, 2));
  const saved = await h.journal.read('source');
  assert.equal(saved.phase, 'summarizing');
  h.coordinator.closed = true;
  release({ hasUnfinishedTask: true, summary: '进程退出前尚未保存的总结。' });
  await interrupted;
  h.host.summarize = async () => ({ hasUnfinishedTask: true, summary: '重启后重新生成的完整任务总结。' });
  const restarted = new HandoffCoordinator(h.host, h.journal);
  try {
    await restarted.recover();
    assert.equal(h.deliveries.length, 1);
    assert.equal(h.deliveries[0].messageId, saved.messageId);
    assert.equal((await h.journal.read('source')).phase, 'done');
  } finally { await restarted.dispose(); }
});

test('startup never sends a saved summary after newer user input and refreshes after the next finished round', async (t) => {
  let events = [end(10), { seq: 11, type: 'user/message', data: {} }];
  const h = await harness(t, { history: async () => ({ events, inheritedEventCount: 0 }) });
  await h.journal.write('source', { phase: 'prepared', sourceSeq: 10,
    nextSessionId: 'changed-target', messageId: 'changed-message', nextTitle: '测试（续3）',
    hasUnfinishedTask: true, summary: '已经过时的旧任务总结。' });
  await h.coordinator.recover();
  assert.equal(h.deliveries.length, 0);
  assert.equal((await h.journal.read('source')).phase, 'prepared');
  events = [...events, end(20)];
  await h.coordinator.recover();
  assert.equal(h.summaries(), 1);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].sourceSeq, 20);
  assert.notEqual(h.deliveries[0].summary, '已经过时的旧任务总结。');
});

test('a malformed journal does not block other recoveries or trigger untouched old sessions', async (t) => {
  const h = await harness(t);
  await h.journal.write('source', { phase: 'prepared', sourceSeq: 10,
    nextSessionId: 'valid-target', messageId: 'valid-message', nextTitle: '测试（续3）',
    hasUnfinishedTask: false, summary: '当前任务已经完成。' });
  await writeFile(h.journal.path('corrupt'), '{broken');
  await h.coordinator.recover();
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.warnings.length, 1);
  assert.deepEqual([...h.coordinator.states.keys()], ['source']);
});

test('continuation title keeps its full suffix within the native UTF-8 limit', () => {
  for (const title of ['测'.repeat(26), '😀'.repeat(20), 'a'.repeat(80),
    '测'.repeat(23) + '（续9）', '测'.repeat(23) + '（续99）']) {
    const expected = title.endsWith('（续9）') ? '（续10）' : title.endsWith('（续99）') ? '（续100）' : '（续1）';
    const result = nextTitle(title, 80);
    assert.ok(Buffer.byteLength(result) <= 80);
    assert.ok(result.endsWith(expected));
    assert.ok(!result.includes('\uFFFD'));
    assert.ok(nextTitle(result, 80).endsWith(expected === '（续1）' ? '（续2）' : expected === '（续10）' ? '（续11）' : '（续101）'));
  }
  assert.equal(fitTitle('测'.repeat(26) + '（续1）', 80), '测'.repeat(23) + '（续1）');
});

test('journal excludes concurrent host coordinators and preserves one child', async (t) => {
  const h = await harness(t);
  const other = new HandoffCoordinator(h.host, h.journal);
  h.coordinator.state('source').eligible = 1;
  other.state('source').eligible = 1;
  await Promise.all([h.coordinator.attempt('source'), other.attempt('source')]);
  assert.equal(h.deliveries.length, 1); assert.equal(h.targets.size, 1);
  await other.dispose();
});

async function lockJournal(t) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-handoff-lock-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return new Journal(dir);
}

test('transient summary failures back off three times, then stop; manual retry keeps stable delivery IDs', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const h = await harness(t, { summarize: async () => {
    calls++;
    throw Object.assign(new Error('temporary transport failure'), { code: 'TRANSPORT' });
  } });
  h.eligible();
  await h.coordinator.attempt('source');
  const saved = await h.journal.read('source');
  for (const delay of [5000, 15000, 45000]) {
    assert.ok((await h.coordinator.status('source')).retryAt);
    t.mock.timers.tick(delay);
    await Promise.all([...h.coordinator.runs]);
  }
  assert.equal(calls, 4);
  assert.equal(h.coordinator.state('source').timer, undefined);
  assert.equal((await h.coordinator.status('source')).retryAt, undefined);
  h.host.summarize = async () => ({ hasUnfinishedTask: false, summary: '重试成功，任务已经完成。' });
  await h.coordinator.retry('source');
  t.mock.timers.tick(120);
  await Promise.all([...h.coordinator.runs]);
  assert.equal(h.deliveries.length, 1);
  assert.equal(h.deliveries[0].messageId, saved.messageId);
  assert.equal(h.deliveries[0].nextSessionId, saved.nextSessionId);
  assert.equal((await h.coordinator.status('source')).phase, 'done');
  await h.coordinator.retry('source');
  assert.equal(h.deliveries.length, 1);
});

test('new input cancels delayed retry and permanent failures never retry automatically', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let calls = 0;
  const h = await harness(t, { summarize: async () => {
    calls++;
    throw Object.assign(new Error('temporary'), { code: 'TIMEOUT' });
  } });
  h.eligible(); await h.coordinator.attempt('source');
  h.coordinator.onEvent(h.session, { seq: 11, type: 'user/message', data: {} });
  t.mock.timers.tick(100000);
  assert.equal(calls, 1);
  assert.equal(h.coordinator.state('source').retryAt, undefined);
  h.host.summarize = async () => { throw Object.assign(new Error('quota exhausted'), { code: 'QUOTA' }); };
  h.eligible(20); await h.coordinator.attempt('source');
  assert.equal(h.coordinator.state('source').timer, undefined);
  assert.equal((await h.coordinator.status('source')).phase, 'error');
  assert.equal(transientFailure(new Error('fetch failed', { cause: { code: 'ECONNRESET' } })), true);
  assert.equal(transientFailure({ code: 'INVALID_CREDENTIAL' }), false);
});

test('model-budget transcript preserves prefix and latest Unicode text without exceeding byte budget', () => {
  const original = '最早的用户要求。' + '😀测试代码ABC'.repeat(5000) + '最后任务下一步。';
  for (const budget of [256, 1024, 8192]) {
    const result = fitTranscript(original, budget);
    assert.ok(Buffer.byteLength(result) <= budget);
    assert.ok(result.startsWith('最早的用户要求。'));
    assert.ok(result.endsWith('最后任务下一步。'));
    assert.ok(!result.includes('\uFFFD'));
    assert.ok(result.includes('模型容量省略'));
  }
  assert.equal(fitTranscript('短文本', 256), '短文本');
});

test('manual retry can recover a startup failure before history was loaded', async (t) => {
  const h = await harness(t);
  Object.assign(h.coordinator.state('source'), { phase: 'error', error: 'temporary history read failure', eligible: null });
  await h.coordinator.retry('source');
  clearTimeout(h.coordinator.state('source').timer); h.coordinator.state('source').timer = undefined;
  await h.coordinator.attempt('source');
  assert.equal(h.deliveries.length, 1);
  assert.equal((await h.coordinator.status('source')).phase, 'done');
});

test('long replies cannot displace recent user requirements or their short follow-up', () => {
  const entries = [
    { type: 'user/message', text: '有效的压缩前缀。' },
    { type: 'user/message', text: 'LATEST_TASK_SENTINEL 路径 C:/exact-project/config.json，只允许读取，禁止写入。' },
    { type: 'user/message', text: '继续刚才的任务。' },
    { type: 'assistant/message', text: '长工具日志😀'.repeat(6000) },
  ];
  const result = summaryTranscript(entries, 4096);
  assert.ok(Buffer.byteLength(result) <= 4096);
  for (const entry of entries.slice(0, 3)) assert.ok(result.includes(entry.text));
  assert.throws(() => summaryTranscript([{ type: 'user/message', text: '超大用户消息'.repeat(10000) }], 1024), /保留原会话/);
  assert.throws(() => summaryTranscript([
    { type: 'user/message', text: 'A'.repeat(3000) + '关键任务路径 C:/exact-project/config.json；禁止部署。' + 'B'.repeat(3000) },
    { type: 'user/message', text: '继续刚才的任务。' },
    { type: 'assistant/message', text: '工具日志'.repeat(20000) },
  ], 4096), /保留原会话/);
  assert.throws(() => summaryTranscript([
    { type: 'user/message', sourceKind: 'compact-checkpoint', text: '已有历史摘要。'.repeat(2000) },
    { type: 'user/message', text: '当前任务路径 C:/current-task.json，保留配置。' },
  ], 4096), /保留原会话/);
});

test('published lock is complete, excludes a live holder and cleans temporary files', async (t) => {
  const journal = await lockJournal(t);
  const unlock = await journal.lock('live');
  assert.equal(typeof unlock, 'function');
  const holder = JSON.parse(await readFile(journal.path('live', '.lock'), 'utf8'));
  assert.equal(holder.pid, process.pid);
  assert.deepEqual(await readdir(journal.directory), [journal.path('live', '.lock').split(/[\\/]/u).at(-1)]);
  assert.equal(await new Journal(journal.directory).lock('live'), undefined);
  assert.deepEqual(JSON.parse(await readFile(journal.path('live', '.lock'), 'utf8')), holder);
  await unlock();
  assert.deepEqual(await readdir(journal.directory), []);
  // An interrupted pre-publication write leaves no public lock to recover.
  await writeFile(journal.path('crash', '.lock.interrupted.tmp'), '');
  const recovered = await journal.lock('crash');
  assert.equal(typeof recovered, 'function');
  await recovered();
});

test('legacy malformed locks stay protected until at least two minutes old', async (t) => {
  const journal = await lockJournal(t);
  for (const [index, content] of ['', '{broken', '{"pid":0}'].entries()) {
    const id = `legacy-${index}`;
    const file = journal.path(id, '.lock');
    await writeFile(file, content);
    assert.equal(await journal.lock(id), undefined);
    assert.equal(await readFile(file, 'utf8'), content);
    const old = new Date(Date.now() - 121000);
    await utimes(file, old, old);
    const unlock = await journal.lock(id);
    assert.equal(typeof unlock, 'function');
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
    await unlock();
    await assert.rejects(stat(file), { code: 'ENOENT' });
  }
  assert.deepEqual(await readdir(journal.directory), []);
});

test('concurrent host windows recover a real dead owner without deleting the new lock', async (t) => {
  const journal = await lockJournal(t);
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' });
  await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
  for (let round = 0; round < 12; round++) {
    const id = `dead-${round}`;
    const file = journal.path(id, '.lock');
    await writeFile(file, JSON.stringify({ pid: child.pid }));
    const contenders = await Promise.all(Array.from({ length: 16 }, () => new Journal(journal.directory).lock(id)));
    const winners = contenders.filter((unlock) => typeof unlock === 'function');
    assert.equal(winners.length, 1);
    assert.equal(JSON.parse(await readFile(file, 'utf8')).pid, process.pid);
    assert.deepEqual(await readdir(journal.directory), [file.split(/[\\/]/u).at(-1)]);
    await winners[0]();
  }
  assert.deepEqual(await readdir(journal.directory), []);
});

test('a normally released lock is reacquired only by atomic publication, never stale removal', async (t) => {
  const journal = await lockJournal(t);
  const id = 'release-race';
  const file = journal.path(id, '.lock');
  const competitor = journal.path(id, '.competitor.tmp');
  const competingOwner = JSON.stringify({ pid: process.pid, marker: 'new-holder' });
  await writeFile(competitor, competingOwner);
  const releaseOld = await journal.lock(id);
  const originalLink = fsPromises.link;
  const originalUnlink = fsPromises.unlink;
  let firstPublication = true;
  let released = false;
  let staleRemovals = 0;
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  t.mock.method(fsPromises, 'link', async (source, destination) => {
    if (destination !== file) return originalLink(source, destination);
    if (firstPublication) {
      firstPublication = false;
      try { return await originalLink(source, destination); }
      catch (error) {
        assert.equal(error.code, 'EEXIST');
        // The old holder releases between EEXIST and the recovery snapshot.
        await releaseOld();
        released = true;
        throw error;
      }
    }
    // A new holder wins before this contender's next publication attempt.
    await originalLink(competitor, file);
    return originalLink(source, destination);
  });
  t.mock.method(fsPromises, 'unlink', async (target) => {
    if (target === file && released) staleRemovals++;
    return originalUnlink(target);
  });
  syncBuiltinESMExports();
  assert.equal(await journal.lock(id), undefined);
  assert.equal(staleRemovals, 0);
  assert.equal(await readFile(file, 'utf8'), competingOwner);
});
