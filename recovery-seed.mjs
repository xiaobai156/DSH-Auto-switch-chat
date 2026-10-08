import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Journal, nextTitle } from './core.js';
import { fixture, makeHost, compactionProjection, createUserMessage } from './runtime-fixture.mjs';

const files = process.argv[2];
const alreadyQueued = process.argv[3] === 'true';
const f = await fixture({ files, persistence: true, maxTitleBytes: 80 });
f.ctx.sessionProjections.register(compactionProjection);
const host = makeHost(f.ctx);
await f.ctx.sessionController.create({ sessionId: 'persisted-source', cwd: files });
const source = f.ctx.agents.get('persisted-source');
f.ctx.sessionTitle.rename(source.session, '测'.repeat(26));
for (let i = 0; i < 3; i++) {
  source.followup(createUserMessage({ source: { kind: 'user' },
    content: [{ type: 'text', text: '隔离恢复验收任务资料。'.repeat(1500) }] }));
  await source.whenIdle();
  await f.ctx.compaction.compactNow(source, new AbortController().signal);
}
if (await host.count(source.id) !== 3) throw new Error('seed compaction count');
const history = await host.history(source.id);
const record = { phase: 'prepared', sourceSeq: history.events.findLast(event => event.type === 'compaction/end').seq,
  nextSessionId: 'persisted-target', messageId: 'persisted-message',
  nextTitle: nextTitle(await host.title(source)), hasUnfinishedTask: alreadyQueued,
  summary: '持久化交接验收：任务资料和完成情况已保存，按当前状态继续。' };
await new Journal(join(files, 'plugin-data', 'session-handoff')).write(source.id, record);
if (alreadyQueued) {
  const target = await host.create(source, record);
  target.session.append('agent/inbox/spliced', {
    target: 'next-turn', start: 0, removedCount: 0,
    inserted: [{ id: record.messageId, role: 'user', source: { kind: 'plugin:dsh-session-handoff' },
      content: [{ type: 'text', text: record.summary }] }],
  });
  await host.flush(target.id);
  if (f.adapter.calls.some(call => call.sessionId === target.id)) throw new Error('seed executed delivery');
}
await host.flush(source.id);
await writeFile(join(files, 'seed-result.json'), JSON.stringify(record));
// Exit without teardown, preserving the exact durable crash boundary and inbox.
process.exit(0);
