import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { HandoffCoordinator, Journal } from './core.js';
import { fixture, makeHost, compactionProjection, createUserMessage, route, native } from './runtime-fixture.mjs';
const { collectAttachments, textOf } = await import('./index.js');

test('real stored attachments survive compaction, delivery, and a cold JSONL reload', async () => {
  let f = await fixture({ persistence: true, attachments: true });
  const files = f.files;
  let coordinator;
  try {
    f.ctx.sessionProjections.register(compactionProjection);
    await f.ctx.sessionController.create({ sessionId: 'attachment-source', cwd: files });
    const source = f.ctx.agents.get('attachment-source');
    const fileBytes = Buffer.from('原始附件要求：保留 ABC-20261008。');
    const file = await f.ctx.attachments.saveFile({ data: fileBytes, name: 'requirements.txt' });
    const { default: sharp } = await import('sharp');
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff6600' } }).png().toBuffer();
    const image = await f.ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'proof.png' });
    const content = [{ type: 'text', text: '按附件和附图继续当前任务。'.repeat(4000) },
      { type: 'file', attachment: file }, { type: 'image', attachment: image }];
    source.session.append('user/message', createUserMessage({ source: { kind: 'user' }, content }), { surfaceOp: 'append' });
    let compacted = false;
    f.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
      if (agent === source && !compacted) {
        compacted = true;
        await f.ctx.compaction.compactRegion(source.session.surface.nodes[0], source.session.surface.nodes.at(-1), source, signal);
      }
      return next();
    });
    source.followup(message('继续原附件对应的任务。'));
    await source.whenIdle();
    assert.ok(!(await f.ctx.sessionQuery.readSurface(source.id)).events.some(event => event.data?.content?.some(block => block.type === 'file')));
    const host = makeHost(f.ctx);
    host.count = async () => 3;
    coordinator = new HandoffCoordinator(host, new Journal(join(files, 'journal')));
    coordinator.state(source.id).eligible = source.session.events?.at(-1)?.seq ?? 999;
    f.adapter.unfinished = false;
    await coordinator.attempt(source.id);
    const status = await coordinator.status(source.id);
    assert.equal(status.phase, 'done', JSON.stringify(status));
    const target = f.ctx.agents.get(status.nextSessionId);
    await target.whenIdle(); await host.flush(target.id);
    const history = await f.ctx.sessionQuery.readSession(target.id);
    const forwarded = collectAttachments(history.events);
    assert.equal(forwarded.length, 2);
    assert.ok(forwarded.find(block => block.type === 'image').offloaded);
    assert.equal(forwarded.find(block => block.type === 'file').attachment.attachmentId, file.attachmentId);
    const description = history.events.filter(event => event.type === 'user/message').map(textOf).join('');
    assert.ok(description.includes('requirements.txt') && description.includes('proof.png'));
    await coordinator.dispose(); coordinator = null;
    await f.close();
    f = await fixture({ files, persistence: true, attachments: true });
    const restored = collectAttachments((await f.ctx.sessionQuery.readSession(target.id)).events);
    assert.deepEqual(restored, forwarded);
    assert.deepEqual(await readFile(f.ctx.attachments.fileHostPath(restored.find(block => block.type === 'file').attachment)), fileBytes);
    assert.ok((await f.ctx.attachments.readImage(restored.find(block => block.type === 'image').attachment)).data.byteLength > 0);
  } finally { await coordinator?.dispose(); await f.close(); }
});

test('selected model capacity bounds Chinese/code summary input and preserves provider failure codes', async () => {
  const f = await fixture({ persistence: true });
  try {
    await f.ctx.sessionController.create({ sessionId: 'budget-source', cwd: f.files });
    const source = f.ctx.agents.get('budget-source');
    source.session.append('user/message', message('当前任务：完成最终验证。路径 C:/exact-project/config.json；禁止修改用户数据。'), { surfaceOp: 'append' });
    f.adapter.replyText = '中文😀代码abcdef'.repeat(10000);
    source.followup(message('继续刚才的任务。'));
    await source.whenIdle();
    const host = makeHost(f.ctx);
    for (const contextWindow of [4096, 16384, null]) {
      f.adapter.contextWindow = contextWindow;
      await host.summarize(source, new AbortController().signal);
      const request = f.adapter.calls.at(-1);
      const prompt = request.messages[0].content[0].text;
      assert.ok(Buffer.byteLength(prompt) + request.maxTokens + 256 < (contextWindow ?? 8192));
      assert.ok(prompt.includes('当前任务：完成最终验证。') && prompt.includes('C:/exact-project/config.json'));
      assert.ok(prompt.includes('禁止修改用户数据。') && prompt.includes('继续刚才的任务。'));
    }
    f.adapter.summaryFailure = { code: 'RATE_LIMIT', message: 'temporary rate limit' };
    await assert.rejects(host.summarize(source, new AbortController().signal), { code: 'RATE_LIMIT' });
  } finally { await f.close(); }
});

test('text-only target receives a readable image tool path in addition to its native attachment', async () => {
  const f = await fixture({ attachments: true });
  try {
    f.adapter.inputModalities = ['text'];
    f.ctx.provide('fs', { processPathFromHostPath: path => path });
    await f.ctx.sessionController.create({ sessionId: 'image-target', cwd: f.files });
    const target = f.ctx.agents.get('image-target');
    const { default: sharp } = await import('sharp');
    const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ff6600' } }).png().toBuffer();
    const ref = await f.ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'source-proof.png' });
    makeHost(f.ctx).deliver(target, { messageId: 'image-delivery', hasUnfinishedTask: true,
      summary: '继续读取附图对应的任务。', attachments: [{ type: 'image', attachment: ref, offloaded: true }] });
    await target.whenIdle();
    const providerText = f.adapter.calls.at(-1).messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n');
    assert.ok(providerText.includes(JSON.stringify(f.ctx.attachments.imageHostPath(ref))), providerText);
    assert.equal(collectAttachments((await f.ctx.sessionQuery.readSession(target.id)).events).length, 1);
  } finally { await f.close(); }
});

test('over-budget native checkpoint preserves the source instead of losing a task followed by continue', async () => {
  const f = await fixture();
  try {
    await f.ctx.sessionController.create({ sessionId: 'checkpoint-budget-source', cwd: f.files });
    const source = f.ctx.agents.get('checkpoint-budget-source');
    source.followup(message('已完成历史参考材料。'.repeat(5000)));
    await source.whenIdle();
    f.adapter.compactionText = '当前任务：只读 C:/current-task.json，保留配置。' + '已完成的历史参考说明。'.repeat(200);
    await f.ctx.compaction.compactNow(source, new AbortController().signal);
    const surface = await f.ctx.sessionQuery.readSurface(source.id);
    assert.ok(surface.events.some(event => event.data?.source?.kind === 'compact-checkpoint'));
    source.session.append('user/message', message('继续刚才的任务。'), { surfaceOp: 'append' });
    f.adapter.contextWindow = 8192;
    const before = f.adapter.calls.length;
    await assert.rejects(makeHost(f.ctx).summarize(source, new AbortController().signal), /更大上下文模型/);
    assert.equal(f.adapter.calls.length, before);
  } finally { await f.close(); }
});

test('retry HTTP route accepts POST only and does not trigger untouched sessions', async () => {
  const previousHome = process.env.DSH_HOME;
  const f = await fixture({ persistence: true });
  try {
    process.env.DSH_HOME = f.files;
    const routes = new Map();
    f.ctx.provide('webServer', { register: route => { routes.set(route.path, route); return () => {}; } });
    await f.ctx.plugin(await import('./index.js'));
    await f.ctx.sessionController.create({ sessionId: 'retry-route-source', cwd: f.files });
    for (let i = 0; i < 50 && !routes.has('/api/session-handoff/retry'); i++) await delay(10);
    const handler = routes.get('/api/session-handoff/retry').handler;
    const invoke = async (method, query = '?sessionId=retry-route-source') => {
      const response = { setHeader() {}, end(text) { this.value = JSON.parse(text); } };
      await handler({ method, url: '/api/session-handoff/retry' + query }, response);
      return response;
    };
    assert.equal((await invoke('GET')).statusCode, 405);
    assert.equal((await invoke('POST', '')).statusCode, 400);
    assert.equal((await invoke('POST')).value.phase, 'watching');
    assert.equal(f.adapter.calls.length, 0);
  } finally {
    await f.close();
    if (previousHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = previousHome;
  }
});

for (const alreadyQueued of [false, true]) {
  test(`cold plugin startup recovers persisted handoff exactly once; alreadyQueued=${alreadyQueued}`, async () => {
    const previousHome = process.env.DSH_HOME;
    let f;
    try {
      const files = await mkdtemp(join(tmpdir(), 'dsh-handoff-crash-'));
      process.env.DSH_HOME = files;
      await new Promise((fulfill, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./recovery-seed.mjs', import.meta.url)), files, String(alreadyQueued)],
          { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        let output = '';
        child.stdout.on('data', chunk => { output += chunk; });
        child.stderr.on('data', chunk => { output += chunk; });
        const timer = setTimeout(() => { child.kill(); reject(new Error('crash seed timeout')); }, 20000);
        child.once('error', error => { clearTimeout(timer); reject(error); });
        child.once('exit', code => { clearTimeout(timer); code === 0 ? fulfill() : reject(new Error(output)); });
      });
      const journal = new Journal(join(files, 'plugin-data', 'session-handoff'));
      const record = JSON.parse(await readFile(join(files, 'seed-result.json'), 'utf8'));
      f = await fixture({ files, persistence: true, maxTitleBytes: 80 });
      let statusRoute;
      f.ctx.provide('webServer', { register: (route) => { if (route.path.endsWith('/status')) statusRoute = route; return () => {}; } });
      assert.equal(f.ctx.agents.list().length, 0, 'startup begins with cold sessions');
      await f.ctx.plugin(await import('./index.js'));
      const deadline = Date.now() + 20000;
      while ((await journal.read('persisted-source')).phase !== 'done') {
        if (Date.now() > deadline) {
          let status;
          await statusRoute.handler({ method: 'GET', url: '/api/session-handoff/status?sessionId=persisted-source' },
            { setHeader() {}, end(text) { status = JSON.parse(text); } });
          throw new Error(`startup handoff did not finish: ${JSON.stringify({ status, record: await journal.read('persisted-source') })}`);
        }
        await delay(20);
      }
      const target = f.ctx.agents.get(record.nextSessionId);
      assert.ok(target, 'the persisted delivery must activate its target');
      await target.whenIdle();
      const targetHistory = await f.ctx.sessionQuery.readSession(target.id);
      assert.equal(targetHistory.events.filter(event => event.type === 'user/message' && event.data.id === record.messageId).length, 1,
        JSON.stringify(targetHistory.events.map(event => ({ seq: event.seq, type: event.type,
          reason: event.data.reason, messageId: event.data.id, source: event.data.source }))));
      assert.equal(f.adapter.calls.filter(call => call.sessionId === target.id).length, alreadyQueued ? 1 : 0);
      assert.equal(f.adapter.calls.filter(call => call.purpose === 'summarization').length, 0);
      const acceptedTitle = (await f.ctx.sessionQuery.readTitle(target.id)).title;
      assert.ok(acceptedTitle.endsWith('（续1）'));
      assert.ok(Buffer.byteLength(acceptedTitle) <= 80);
      assert.equal(f.ctx.sessionProjections.stateOf(target.session, 'sessionHandoffCompactions').count, 0);
      assert.equal(f.ctx.sessionProjections.stateOf(target.session, 'sessionListMetadata').blank, false);
      await f.ctx.sessions.flush(target.session);
      await f.ctx.sessionPersistence.flush();
      const committed = await journal.read('persisted-source');
      await f.close();
      f = await fixture({ files, persistence: true, maxTitleBytes: 80 });
      f.ctx.provide('webServer', { register: () => () => {} });
      await f.ctx.plugin(await import('./index.js'));
      await delay(180);
      assert.equal(f.ctx.agents.list().length, 0, 'a second restart must not re-run a finished transfer');
      assert.equal(f.adapter.calls.length, 0);
      assert.deepEqual(await journal.read('persisted-source'), committed);
    } finally {
      await f?.close();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
    }
  });
}

const message = text => createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text }] });

test('isolated real DSH core emits genuine turns and successful/failed compactions', async () => {
  const f = await fixture();
  try {
    const handle = await f.ctx.agents.create({ sessionId: 'integration-source', agentOptions: route, meta: { cwd: resolve(f.files) } });
    const agent = handle.agent;
    const observed = [];
    f.ctx.on('session/event', (session, event) => { if (session === agent.session) observed.push(event); });
    agent.followup(message('测试任务。' + '真实上下文内容，确保压缩后更短。'.repeat(200)));
    await agent.whenIdle();
    assert.equal(observed.findLast(e => e.type === 'turn/end').data.reason.kind, 'completed');
    await f.ctx.compaction.compactNow(agent, new AbortController().signal);
    assert.equal(observed.filter(e => e.type === 'compaction/end' && !e.data.error).length, 1);
  } finally { await f.close(); }
});

for (const unfinished of [true, false]) {
  test(`three genuine compactions hand off exactly once; unfinished=${unfinished}`, async () => {
    const f = await fixture();
    let coordinator;
    try {
      f.adapter.unfinished = unfinished;
      f.ctx.sessionProjections.register(compactionProjection);
      const host = makeHost(f.ctx);
      // The fixture has no disk persistence adapter; keep the real session flush
      // seam instead of supplying a fake writer which could change creation.
      host.flush = () => Promise.all(f.ctx.sessions.list().map(session => f.ctx.sessions.flush(session)));
      coordinator = new HandoffCoordinator(host, new Journal(join(f.files, 'journal')));
      f.ctx.on('session/event', (session, event) => coordinator.onEvent(session, event));
      f.ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') coordinator.onIdle(agent.id); });
      await f.ctx.sessionController.create({ sessionId: 'integration-source', cwd: resolve(f.files) });
      const source = f.ctx.agents.get('integration-source');
      f.ctx.sessionTitle.rename(source.session, 'DSH 插件开发（续2）');
      source.session.append('user/message', message('测试会话此前已经处理的任务材料。'.repeat(1200)), { surfaceOp: 'append' });
      const gate = Promise.withResolvers();
      f.adapter.held = gate;
      const compactionsDone = Promise.withResolvers();
      let hookRan = false;
      const observed = [];
      f.ctx.on('session/event', (session, event) => { if (session === source.session) observed.push(event); });
      f.ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
        if (agent !== source || hookRan) return next();
        hookRan = true;
        try {
          const compact = () => {
            const nodes = source.session.surface.nodes;
            return f.ctx.compaction.compactRegion(nodes[0], nodes.at(-1), source, signal);
          };
          f.adapter.failCompaction = true;
          await assert.rejects(compact(), /deliberate compaction failure/);
          assert.equal(await host.count(source.id), 0, 'failed compression must not count');
          f.adapter.failCompaction = false;
          for (let i = 0; i < 3; i++) {
            if (i) source.session.append('user/message', message('补充任务材料。'.repeat(1200)), { surfaceOp: 'append' });
            await compact();
            assert.equal(await host.count(source.id), i + 1);
            assert.equal(f.ctx.agents.list().length, 1, 'never hand off inside active turn');
          }
          compactionsDone.resolve();
        } catch (error) { compactionsDone.reject(error); throw error; }
        return next();
      });
      source.followup(message('继续当前尚未完成的测试任务。' + '真实任务上下文。'.repeat(1200)));
      await compactionsDone.promise;
      await delay(180);
      assert.equal(f.ctx.agents.list().length, 1);
      assert.equal((await coordinator.status(source.id)).count, 3);
      assert.equal(observed.filter(e => e.type === 'compaction/end' && !e.data.error).length, 3);
      assert.equal(observed.filter(e => e.type === 'compaction/end' && e.data.error).length, 1);
      f.adapter.held = null;
      gate.resolve();
      await source.whenIdle();
      for (let i = 0; i < 100 && (await coordinator.status(source.id)).phase !== 'done'; i++) await delay(20);
      const status = await coordinator.status(source.id);
      assert.equal(status.phase, 'done', JSON.stringify(status));
      assert.equal(f.ctx.agents.list().length, 2);
      const target = f.ctx.agents.get(status.nextSessionId);
      await target.whenIdle();
      assert.equal((await f.ctx.sessionQuery.readTitle(target.id)).title, 'DSH 插件开发（续3）');
      assert.equal(target.session.header.cwd, source.session.header.cwd);
      assert.deepEqual({ provider: target.options.provider, model: target.options.model }, route);
      assert.equal(await host.count(target.id), 0);
      assert.equal(target.status, 'idle');
      const log = (await f.ctx.sessionQuery.readSession(target.id)).events;
      assert.equal(log.filter(e => e.type === 'user/message').length, 1);
      assert.equal(log.filter(e => e.type === 'turn/end').length, 1);
      assert.equal(f.ctx.sessionProjections.stateOf(target.session, 'sessionListMetadata').blank, false);
      assert.equal(f.adapter.calls.filter(c => c.sessionId === target.id).length, unfinished ? 1 : 0);
      assert.equal(f.adapter.calls.filter(c => c.purpose === 'summarization').length, 1);
      if (!unfinished) {
        target.followup(message('新的独立用户任务。'));
        await target.whenIdle();
        const later = (await f.ctx.sessionQuery.readSession(target.id)).events.filter(e => e.type === 'turn/start');
        assert.deepEqual(later.map(e => e.data.turn), [1, 2], 'record-only turn must preserve the native next-turn counter');
      }
      coordinator.onIdle(source.id);
      coordinator.schedule(source.id);
      await delay(180);
      assert.equal(f.ctx.agents.list().length, 2, 'replayed idle must not duplicate handoff');
      assert.equal(f.adapter.calls.filter(c => c.purpose === 'summarization').length, 1);
    } finally {
      f.adapter.held?.resolve();
      await coordinator?.dispose();
      await f.close();
    }
  });
}

async function readySource(f, id) {
  f.ctx.sessionProjections.register(compactionProjection);
  await f.ctx.sessionController.create({ sessionId: id, cwd: f.files });
  const source = f.ctx.agents.get(id);
  source.followup(message('当前任务尚未完成。' + '隔离的真实压缩上下文。'.repeat(1200)));
  await source.whenIdle();
  for (let i = 0; i < 3; i++) {
    if (i) source.session.append('user/message', message('补充真实上下文。'.repeat(1200)), { surfaceOp: 'append' });
    await f.ctx.compaction.compactNow(source, new AbortController().signal);
  }
  return source;
}

async function coordinatorFor(f, source, journal = new Journal(join(f.files, 'journal'))) {
  const host = makeHost(f.ctx);
  const coordinator = new HandoffCoordinator(host, journal);
  f.ctx.on('session/event', (session, event) => coordinator.onEvent(session, event));
  f.ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') coordinator.onIdle(agent.id); });
  coordinator.state(source.id).eligible = (await host.history(source.id)).events.at(-1).seq;
  return { coordinator, host, journal };
}

for (const phase of ['active', 'paused', 'blocked', 'disarmed', 'round-limit']) {
  test(`native Goal ${phase} retains its owner and round authority instead of spawning ordinary work`, async () => {
    const f = await fixture({ persistence: true });
    let coordinator;
    try {
      await f.ctx.plugin((await native('dsh-goal')).default, {});
      const source = await readySource(f, `goal-${phase}`);
      if (phase === 'round-limit') await f.ctx.plugin(await native('dsh-goal-round-driver'));
      let goal = f.ctx.goals.create(source, { objective: '保留原目标的停止条件和轮数上限。', maxGoalRounds: phase === 'round-limit' ? 1 : 4 });
      if (phase === 'paused') goal = f.ctx.goals.pause(source, goal);
      if (phase === 'blocked') goal = f.ctx.goals.block(source, goal, { code: 'required-input', message: '等待用户提供必需信息。' });
      if (phase === 'disarmed') goal = f.ctx.goals.disarm(source);
      if (phase === 'round-limit') {
        for (let i = 0; i < 200 && f.ctx.goals.get(source).phase !== 'blocked'; i++) await delay(5);
        goal = f.ctx.goals.get(source);
        assert.equal(goal.blockedReason.code, 'round-limit');
        assert.equal(goal.roundsStarted, 1);
      }
      const h = await coordinatorFor(f, source);
      coordinator = h.coordinator;
      await coordinator.attempt(source.id);
      assert.equal((await coordinator.status(source.id)).phase, 'deferred');
      assert.equal((await coordinator.status(source.id)).reason, 'goal');
      assert.equal(f.ctx.agents.list().length, 1);
      assert.equal(f.adapter.calls.filter(call => call.purpose === 'summarization').length, 0);
      assert.deepEqual(f.ctx.goals.get(source), goal);
      f.adapter.unfinished = false;
      f.ctx.goals.complete(source, goal);
      for (let i = 0; i < 100 && (await coordinator.status(source.id)).phase !== 'done'; i++) await delay(5);
      assert.equal((await coordinator.status(source.id)).phase, 'done', JSON.stringify(await coordinator.status(source.id)));
      const target = f.ctx.agents.get((await coordinator.status(source.id)).nextSessionId);
      await target.whenIdle();
      assert.equal(f.adapter.calls.filter(call => call.sessionId === target.id).length, 0);
    } finally { await coordinator?.dispose(); await f.close(); }
  });
}

test('native subagent residency and final result are settled in the old parent before handoff', async () => {
  const f = await fixture({ persistence: true });
  const gate = Promise.withResolvers();
  let coordinator;
  try {
    await f.ctx.plugin((await native('dsh-subagent')).default, {});
    await f.ctx.plugin(await native('dsh-subagent-spawn-in-process'), { providerName: 'spawn' });
    const source = await readySource(f, 'subagent-source');
    const h = await coordinatorFor(f, source);
    coordinator = h.coordinator;
    f.adapter.held = gate;
    f.adapter.replyText = 'CHILD_RESULT_SENTINEL：隔离检查已完成，原父会话必须先处理此结果。';
    const child = await f.ctx.subagents.startContinuable({ provider: 'spawn', label: 'isolated-worker',
      request: { parent: source, prompt: [{ type: 'text', text: '隔离检查子任务。' }] }, signal: new AbortController().signal });
    for (let i = 0; i < 50 && f.ctx.agents.get(child.childId)?.status !== 'running'; i++) await delay(2);
    await coordinator.attempt(source.id);
    assert.equal((await coordinator.status(source.id)).reason, 'subagents');
    assert.equal(f.ctx.agents.list().length, 2, 'only parent and original child exist');
    f.adapter.held = null; gate.resolve();
    for (let i = 0; i < 300 && (await coordinator.status(source.id)).phase !== 'done'; i++) await delay(5);
    assert.equal((await coordinator.status(source.id)).phase, 'done');
    assert.equal(f.ctx.agents.get(child.childId), undefined, 'native child ownership was released before transfer');
    assert.ok((await h.host.history(source.id)).events.some(event => event.type === 'user/message' &&
      event.data.content.some(block => block.type === 'text' && block.text.includes('CHILD_RESULT_SENTINEL'))));
    const summary = f.adapter.calls.find(call => call.purpose === 'summarization');
    assert.ok(summary.messages[0].content[0].text.includes('CHILD_RESULT_SENTINEL'));
  } finally { gate.resolve(); f.adapter.held = null; await coordinator?.dispose(); await f.close(); }
});

test('native tool images survive raw-history collection, handoff, and cold attachment reload', async () => {
  let f = await fixture({ persistence: true, attachments: true });
  let coordinator;
  try {
    const source = await readySource(f, 'native-tool-image');
    const { default: sharp } = await import('sharp');
    const png = await sharp({ create: { width: 3, height: 2, channels: 3, background: '#2468ac' } }).png().toBuffer();
    const image = await f.ctx.attachments.saveImage({ data: png, mediaType: 'image/png', name: 'native-tool-screenshot.png' });
    f.ctx.tools.register({ name: 'test_image', description: 'Return a stored test screenshot.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: { schema: { type: 'object', properties: {}, additionalProperties: false }, render: () => [{ type: 'image', attachment: image }] },
      execute: async () => ({}) });
    const stream = f.adapter.stream.bind(f.adapter);
    let first = true;
    f.adapter.stream = async function* (request) {
      if (first && request.sessionId === source.id && request.purpose !== 'summarization') {
        first = false; this.calls.push(request);
        yield { type: 'tool-call-delta', index: 0, id: 'test-image-call', name: 'test_image', argumentsDelta: '{}' };
        yield { type: 'finish', reason: { kind: 'tool-calls' } };
      } else yield* stream(request);
    };
    source.followup(message('读取工具截图后继续当前任务。'));
    await source.whenIdle();
    const original = collectAttachments((await f.ctx.sessionQuery.readSession(source.id)).events);
    assert.equal(original.length, 1);
    assert.equal(original[0].attachment.attachmentId, image.attachmentId);
    f.adapter.unfinished = false;
    const h = await coordinatorFor(f, source);
    coordinator = h.coordinator;
    await coordinator.attempt(source.id);
    const targetId = (await coordinator.status(source.id)).nextSessionId;
    await f.ctx.agents.get(targetId).whenIdle(); await h.host.flush(targetId);
    const forwarded = collectAttachments((await h.host.history(targetId)).events);
    assert.deepEqual(forwarded, original);
    const files = f.files;
    await coordinator.dispose(); coordinator = null; await f.close();
    f = await fixture({ files, persistence: true, attachments: true });
    const restored = collectAttachments((await f.ctx.sessionQuery.readSession(targetId)).events);
    assert.equal(restored.length, 1);
    assert.ok((await f.ctx.attachments.readImage(restored[0].attachment)).data.byteLength > 0);
  } finally { await coordinator?.dispose(); await f.close(); }
});

test('new source input during durable commit executes once in the continuation and never in the old source', async () => {
  const f = await fixture({ persistence: true });
  let coordinator, running;
  const flushStarted = Promise.withResolvers(), releaseFlush = Promise.withResolvers();
  const replyGate = Promise.withResolvers();
  try {
    const source = await readySource(f, 'late-input-source');
    const h = await coordinatorFor(f, source);
    coordinator = h.coordinator;
    const flush = h.host.flush;
    h.host.flush = async id => {
      if (id !== source.id) { flushStarted.resolve(id); await releaseFlush.promise; }
      await flush(id);
    };
    running = coordinator.attempt(source.id);
    const targetId = await flushStarted.promise;
    f.adapter.held = replyGate;
    const late = message('NEW_INPUT_DURING_COMMIT：按新增要求继续，保留附件和原消息编号。');
    source.followup(late);
    await delay(10);
    assert.equal(f.adapter.calls.some(call => call.sessionId === source.id &&
      call.messages.some(msg => msg.content.some(block => block.text?.includes('NEW_INPUT_DURING_COMMIT')))), false);
    releaseFlush.resolve(); await running;
    await source.whenIdle();
    f.adapter.held = null; replyGate.resolve();
    const target = f.ctx.agents.get(targetId);
    await target.whenIdle();
    const log = await h.host.history(targetId);
    assert.equal(log.events.filter(event => event.type === 'user/message' && event.data.id === late.id).length, 1);
    assert.ok(f.adapter.calls.some(call => call.sessionId === targetId &&
      call.messages.some(msg => msg.content.some(block => block.text?.includes('NEW_INPUT_DURING_COMMIT')))));
    assert.equal(f.adapter.calls.some(call => call.sessionId === source.id &&
      call.messages.some(msg => msg.content.some(block => block.text?.includes('NEW_INPUT_DURING_COMMIT')))), false);
    assert.equal((await coordinator.status(source.id)).phase, 'done');
  } finally {
    releaseFlush.resolve(); replyGate.resolve(); f.adapter.held = null;
    await running; await coordinator?.dispose(); await f.close();
  }
});

test('cold restart replays durable source input after ownership commit without repeating either message', async () => {
  let f = await fixture({ persistence: true });
  let coordinator;
  const journal = new Journal(join(f.files, 'journal'));
  const files = f.files;
  const late = message('COLD_FORWARD_SENTINEL：交接归属保存后尚未转发的新输入。');
  let targetId;
  try {
    const source = await readySource(f, 'cold-forward-source');
    f.adapter.unfinished = false;
    let h = await coordinatorFor(f, source, journal);
    coordinator = h.coordinator;
    await coordinator.attempt(source.id);
    const record = await journal.read(source.id);
    targetId = record.nextSessionId;
    await f.ctx.agents.get(targetId).whenIdle();
    source.session.append('user/message', late, { surfaceOp: 'append' });
    await h.host.flush(source.id);
    await journal.write(source.id, { ...record, phase: 'committing' });
    await coordinator.dispose(); coordinator = null; await f.close();
    f = await fixture({ files, persistence: true });
    f.ctx.sessionProjections.register(compactionProjection);
    h = { host: makeHost(f.ctx) };
    coordinator = new HandoffCoordinator(h.host, journal);
    await coordinator.recover();
    assert.equal((await journal.read('cold-forward-source')).phase, 'done', JSON.stringify(await coordinator.status('cold-forward-source')));
    await f.ctx.agents.get(targetId).whenIdle(); await h.host.flush(targetId);
    assert.equal((await h.host.history(targetId)).events.filter(event => event.type === 'user/message' && event.data.id === late.id).length, 1);
    assert.equal(f.adapter.calls.filter(call => call.sessionId === targetId).length, 1);
    await coordinator.dispose(); coordinator = null; await f.close();
    f = await fixture({ files, persistence: true });
    f.ctx.sessionProjections.register(compactionProjection);
    coordinator = new HandoffCoordinator(makeHost(f.ctx), journal);
    await coordinator.recover();
    assert.equal((await journal.read('cold-forward-source')).phase, 'done', JSON.stringify(await coordinator.status('cold-forward-source')));
    assert.equal(f.adapter.calls.length, 0);
    assert.equal(f.ctx.agents.list().length, 0);
  } finally { await coordinator?.dispose(); await f.close(); }
});

test('permanent native summary failure stays stopped after a real JSONL reload until manual retry', async () => {
  let f = await fixture({ persistence: true });
  let coordinator;
  const files = f.files, journal = new Journal(join(files, 'journal'));
  try {
    const source = await readySource(f, 'native-permanent-error');
    let h = await coordinatorFor(f, source, journal);
    coordinator = h.coordinator;
    f.adapter.summaryFailure = { code: 'INVALID_CREDENTIAL', message: 'isolated permanent error' };
    await coordinator.attempt(source.id);
    assert.equal((await journal.read(source.id)).phase, 'error');
    await h.host.flush(source.id); await coordinator.dispose(); coordinator = null; await f.close();
    f = await fixture({ files, persistence: true });
    f.ctx.sessionProjections.register(compactionProjection);
    h = { host: makeHost(f.ctx) };
    coordinator = new HandoffCoordinator(h.host, journal);
    await coordinator.recover();
    assert.equal(f.adapter.calls.length, 0);
    assert.equal((await coordinator.status('native-permanent-error')).phase, 'error');
    await coordinator.retry('native-permanent-error');
    clearTimeout(coordinator.state('native-permanent-error').timer); coordinator.state('native-permanent-error').timer = undefined;
    await coordinator.attempt('native-permanent-error');
    assert.equal((await coordinator.status('native-permanent-error')).phase, 'done');
    assert.equal(f.adapter.calls.filter(call => call.purpose === 'summarization').length, 1);
  } finally { await coordinator?.dispose(); await f.close(); }
});

for (const failRecordInput of [false, true]) {
  test(`v1.0.2 record-only logs migrate without losing claimed input or corrupting cold reads; interrupted=${failRecordInput}`, async () => {
    let f = await fixture({ persistence: true });
    const files = f.files, journal = new Journal(join(files, 'journal'));
    let coordinator, targetId;
    try {
      f.ctx.on('agent/pre-step', ({ agent, messages }, next) => {
        if (!messages.length || !messages.every(item => item.source.kind === 'plugin:dsh-session-handoff:record-only')) return next();
        for (const item of messages) agent.session.append('user/message', item, { surfaceOp: 'append' });
        return { kind: 'enter', messages: [] };
      }, { prepend: true });
      await f.ctx.sessionController.create({ sessionId: 'legacy-note', cwd: files });
      let source = f.ctx.agents.get('legacy-note');
      source.followup(createUserMessage({ source: { kind: 'plugin:dsh-session-handoff:record-only' },
        content: [{ type: 'text', text: '旧版本保存的完成任务交接记录。' }] }));
      await source.whenIdle();
      await f.ctx.sessions.flush(source.session); await f.ctx.sessionPersistence.flush();
      assert.equal(f.adapter.calls.length, 0);
      await f.close();
      f = await fixture({ files, persistence: true });
      f.ctx.sessionProjections.register(compactionProjection);
      const host = makeHost(f.ctx);
      coordinator = new HandoffCoordinator(host, journal);
      source = await host.restore('legacy-note');
      const recordInput = host.recordInput;
      if (failRecordInput) host.recordInput = async () => { throw Object.assign(new Error('interrupted legacy migration'), { code: 'TRANSPORT' }); };
      const late = message('UPGRADED_CLAIMED_INPUT：升级后首次真实输入必须只执行一次。');
      source.followup(late); await source.whenIdle();
      if (failRecordInput) {
        const saved = await journal.read(source.id);
        assert.equal(saved.phase, 'error');
        assert.ok(saved.forwardAfterSeq < saved.sourceSeq);
        assert.equal((await host.history(source.id)).events.some(event => event.type === 'user/message' && event.data.id === late.id), false);
        host.recordInput = recordInput;
        await coordinator.retry(source.id);
        clearTimeout(coordinator.state(source.id).timer); coordinator.state(source.id).timer = undefined;
        await coordinator.attempt(source.id);
      }
      assert.equal((await coordinator.status(source.id)).phase, 'done');
      targetId = (await coordinator.status(source.id)).nextSessionId;
      await f.ctx.agents.get(targetId).whenIdle(); await host.flush(targetId); await host.flush(source.id);
      assert.equal((await host.history(targetId)).events.filter(event => event.type === 'user/message' && event.data.id === late.id).length, 1);
      assert.equal(f.adapter.calls.filter(call => call.sessionId === targetId).length, 1);
      assert.equal(f.adapter.calls.filter(call => call.sessionId === source.id).length, 0);
      await coordinator.dispose(); coordinator = null; await f.close();
      f = await fixture({ files, persistence: true });
      await f.ctx.sessionQuery.readSession('legacy-note');
      await f.ctx.sessionQuery.readSession(targetId);
    } finally { await coordinator?.dispose(); await f.close(); }
  });
}

test('a legacy completed journal never upgrades ownership or replays work already executed in its source', async () => {
  let f = await fixture({ persistence: true });
  const files = f.files, journal = new Journal(join(files, 'journal'));
  let coordinator;
  try {
    let source = await readySource(f, 'legacy-done');
    f.adapter.unfinished = false;
    let h = await coordinatorFor(f, source, journal); coordinator = h.coordinator;
    await coordinator.attempt(source.id);
    const record = await journal.read(source.id);
    await f.ctx.agents.get(record.nextSessionId).whenIdle(); await h.host.flush(record.nextSessionId); await h.host.flush(source.id);
    delete record.routing; await journal.write(source.id, record);
    await coordinator.dispose(); coordinator = null; await f.close();
    f = await fixture({ files, persistence: true });
    f.ctx.sessionProjections.register(compactionProjection);
    h = { host: makeHost(f.ctx) }; coordinator = new HandoffCoordinator(h.host, journal);
    await coordinator.recover(); source = await h.host.restore('legacy-done');
    const late = message('LEGACY_SOURCE_ONLY：旧版已完成交接不能吞掉后来发给源会话的新任务。');
    source.followup(late); await source.whenIdle();
    assert.equal(f.adapter.calls.filter(call => call.sessionId === source.id).length, 1);
    assert.equal(await h.host.hasMessage(record.nextSessionId, late.id), false);
    assert.equal((await journal.read(source.id)).routing, undefined);
  } finally { await coordinator?.dispose(); await f.close(); }
});

test('committed ownership recreates a target missing from the native persistence store', async () => {
  const f = await fixture({ persistence: true });
  let coordinator;
  try {
    const source = await readySource(f, 'missing-durable-target');
    const h = await coordinatorFor(f, source); coordinator = h.coordinator;
    const record = { phase: 'committing', routing: true, sourceSeq: (await h.host.history(source.id)).events.at(-1).seq,
      nextSessionId: 'not-yet-persisted-target', messageId: 'not-yet-persisted-message', nextTitle: '恢复（续1）',
      hasUnfinishedTask: false, summary: '原子归属保存后，目标会话尚未落盘时被中断。' };
    await h.journal.write(source.id, record); await coordinator.recover();
    assert.equal((await coordinator.status(source.id)).phase, 'done');
    await f.ctx.agents.get(record.nextSessionId).whenIdle();
    assert.equal(await h.host.hasMessage(record.nextSessionId, record.messageId), true);
    assert.equal(f.adapter.calls.filter(call => call.sessionId === record.nextSessionId).length, 0);
  } finally { await coordinator?.dispose(); await f.close(); }
});

test('stopping during commit cancels the continuation and survives cold input until explicit retry', async () => {
  let f = await fixture({ persistence: true });
  const files = f.files, journal = new Journal(join(files, 'journal'));
  const started = Promise.withResolvers(), release = Promise.withResolvers(), replyGate = Promise.withResolvers();
  let coordinator, running, targetId;
  const late = message('STOPPED_OLD_INPUT：停止后禁止自动恢复这条输入。');
  try {
    let source = await readySource(f, 'stopped-commit');
    let h = await coordinatorFor(f, source, journal); coordinator = h.coordinator;
    const flush = h.host.flush; let held = false;
    h.host.flush = async id => {
      if (id !== source.id && !held) { held = true; started.resolve(id); await release.promise; }
      await flush(id);
    };
    f.adapter.held = replyGate;
    running = coordinator.attempt(source.id); targetId = await started.promise;
    source.followup(late); await delay(25);
    source.cancel({ kind: 'user' }, { keepInbox: true });
    release.resolve(); await running; await source.whenIdle();
    assert.ok(f.ctx.agents.get(targetId).phase.abort.signal.aborted);
    f.adapter.held = null; replyGate.resolve(); await f.ctx.agents.get(targetId).whenIdle();
    assert.equal(await h.host.hasMessage(targetId, late.id), false);
    assert.equal((await journal.read(source.id)).stopped, true);
    await h.host.flush(source.id); await h.host.flush(targetId); await coordinator.dispose(); coordinator = null; await f.close();
    f = await fixture({ files, persistence: true });
    f.ctx.sessionProjections.register(compactionProjection);
    h = { host: makeHost(f.ctx) }; coordinator = new HandoffCoordinator(h.host, journal);
    await coordinator.recover();
    assert.equal(f.adapter.calls.length, 0);
    source = await h.host.restore('stopped-commit');
    const fresh = message('NEW_INPUT_WITHOUT_RETRY：新消息不能复活已停止的旧任务。');
    source.followup(fresh); await source.whenIdle();
    assert.equal(f.adapter.calls.length, 0);
    assert.equal((await coordinator.status(source.id)).phase, 'error');
    assert.equal((await journal.read(source.id)).stopped, true);
    await coordinator.retry(source.id);
    clearTimeout(coordinator.state(source.id).timer); coordinator.state(source.id).timer = undefined;
    await coordinator.attempt(source.id); await f.ctx.agents.get(targetId).whenIdle();
    assert.equal((await coordinator.status(source.id)).phase, 'done');
    const log = await h.host.history(targetId);
    for (const item of [late, fresh]) assert.equal(log.events.filter(event => event.type === 'user/message' && event.data.id === item.id).length, 1);
  } finally {
    release.resolve(); replyGate.resolve(); f.adapter.held = null;
    await running; await coordinator?.dispose(); await f.close();
  }
});
