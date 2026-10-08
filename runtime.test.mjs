import test from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { HandoffCoordinator, Journal } from './core.js';
import { fixture, makeHost, compactionProjection, createUserMessage, route } from './runtime-fixture.mjs';
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
