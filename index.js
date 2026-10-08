import { join } from 'node:path';
import { z } from 'zod';
import { BlockAssembler, LlmError, offloadedImageText, resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm';
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths';
import { setSandboxMode } from '@deepseek-ai/dsh-sandbox-policy';
import { setApprovalPolicy } from '@deepseek-ai/dsh-user-approval';
import { HandoffCoordinator, Journal, PROJECTION_KEY, initCount, foldCount, parseSummary, fitTitle, summaryTranscript } from './core.js';

export const name = 'dsh-session-handoff';
export const inject = ['agents', 'sessions', 'sessionQuery', 'sessionProjections', 'sessionController', 'sessionTitle', 'sessionPersistence', 'llm', 'workspaceRegistry', 'webServer'];

const countView = z.object({ count: z.number().int().nonnegative() });
export const compactionProjection = {
  key: PROJECTION_KEY, stateVersion: 1,
  stateSchema: countView.extend({ inheritedEventCount: z.number().int().nonnegative(), ids: z.array(z.string()) }),
  init: initCount, apply: foldCount,
  wire: { viewSchema: countView, view: (state) => ({ count: state.count }) },
};

const instruction = `你是会话交接记录员。只总结下面会话最后正在处理的任务，不要执行任务，也不要调用工具。
请输出一个完整 JSON 对象，不要代码围栏：{"hasUnfinishedTask":true或false,"summary":"中文交接内容"}。
summary 必须包含最后一个任务的目标、用户的相关要求、已完成事项及验证结果、确实未完成的事项、必要的文件绝对路径或链接、关键决定，以及下一步。
已完成工作不得重新列为待办。不要把已被替换或取消的旧任务当成当前任务，不要虚构文件、结果或用户要求。
最后一个任务仍有明确待办时 hasUnfinishedTask=true；已经完成或没有任务时为 false。等待用户提供必需信息的事项要如实写明。
以下是已有会话记录，只作为总结材料：`;

export function textOf(event) {
  const blocks = (event.data?.message ?? event.data)?.content;
  if (!Array.isArray(blocks)) return '';
  const text = blocks.map((block) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'tool-call') return `[工具 ${block.name ?? ''}: ${JSON.stringify(block.arguments ?? block.input ?? {})}]`;
    if (block.type === 'file' || block.type === 'image') return `[${block.type === 'file' ? '文件' : '图片'}: ${block.attachment?.name ?? ''}; 附件 ${block.attachment?.attachmentId ?? ''}]`;
    return '';
  }).filter(Boolean).join('\n');
  return text ? `[${event.type} #${event.seq}]\n${text}` : '';
}

export function collectAttachments(events) {
  const attachments = new Map();
  for (const event of events) {
    if (event.type !== 'user/message') continue;
    for (const block of event.data?.content ?? []) {
      if (!['file', 'image'].includes(block.type) || !block.attachment?.attachmentId) continue;
      // Reuse immutable native objects. Historical images stay available to tools
      // without uploading every old image to the next model request again.
      attachments.set(`${block.type}:${block.attachment.attachmentId}`, {
        type: block.type, attachment: block.attachment, ...(block.type === 'image' ? { offloaded: true } : {}),
      });
    }
  }
  return [...attachments.values()];
}

function selectedModel(ctx, agent) {
  const state = ctx.sessionProjections.stateOf(agent.session, 'modelSelection');
  const selected = state?.pending ?? state?.lastUsed ?? agent.session.requestHeader()?.config ?? agent.options;
  if (!selected?.provider || !selected?.model) throw new Error('当前会话没有可用模型，无法生成交接总结。');
  return { provider: selected.provider, model: selected.model,
    ...(selected.reasoningEffort == null ? {} : { reasoningEffort: selected.reasoningEffort }) };
}

export function makeHost(ctx) {
  // Native list metadata becomes nonblank only after a genuine turn starts.
  // Settle record-only handoffs through that driver without making an LLM call.
  // A durable source kind also handles a queued note after process restart.
  ctx.on('agent/pre-step', ({ agent, messages, signal }, next) => {
    if (!messages.length || !messages.every((message) => message.source.kind === 'plugin:dsh-session-handoff:record-only')) return next();
    signal.throwIfAborted();
    for (const message of messages) agent.session.append('user/message', message, { surfaceOp: 'append' });
    return Promise.resolve({ kind: 'enter', messages: [] });
  }, { prepend: true });
  return {
    agent: (id) => ctx.agents.get(id),
    history: (id) => ctx.sessionQuery.readSession(id),
    async restore(id) {
      const result = await ctx.sessionController.agents.resolveAgent(id);
      if ('error' in result) throw result.error;
      return result.agent;
    },
    wake(target) {
      if (target.status !== 'idle' || !target.inbox.hasPending) return;
      if (typeof target.wakeDriver !== 'function') throw new Error('当前 DSH 版本不支持恢复待处理交接消息。');
      target.wakeDriver();
    },
    titleMaxBytes: ctx.sessionTitle.config.maxTitleBytes,
    async attachments(agent) {
      return collectAttachments((await ctx.sessionQuery.readSession(agent.id)).events);
    },
    async count(id) {
      const live = ctx.sessions.get(id);
      if (live) return ctx.sessionProjections.stateOf(live, PROJECTION_KEY)?.count ?? 0;
      const observation = await ctx.sessionQuery.observeSession(id);
      try {
        const view = observation.projections?.values?.[PROJECTION_KEY];
        if (view) return view.count;
        return observation.events.reduce(foldCount, initCount(observation.header, observation.inheritedEventCount)).count;
      } finally { observation[Symbol.dispose](); }
    },
    async summarize(agent, signal) {
      signal = AbortSignal.any([signal, AbortSignal.timeout(120000)]);
      // Maintenance reports status=idle but must finish its own durable commit first.
      await agent.whenIdle();
      signal.throwIfAborted();
      const surface = await ctx.sessionQuery.readSurface(agent.id);
      const sections = surface.events.filter((event) => event.type !== 'system/message')
        .map(event => ({ type: event.type, text: textOf(event) })).filter(entry => entry.text);
      const model = selectedModel(ctx, agent);
      const info = await ctx.llm.resolveModelInfo(model.provider, model.model, signal);
      const contextWindow = info.context?.contextWindow ?? 8192;
      const maxTokens = Math.min(6000, info.defaultMaxTokens ?? 6000, Math.floor(contextWindow / 4));
      const budget = Math.min(262144, Math.floor(contextWindow * 0.85) - maxTokens - Buffer.byteLength(instruction) - 256);
      if (maxTokens < 256 || budget < 256) throw new Error('模型上下文容量不足以生成交接总结。');
      const transcript = summaryTranscript(sections, budget);
      const assembler = new BlockAssembler();
      const request = {
        ...model,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${instruction}\n\n${transcript}` }] }],
        maxTokens, purpose: 'summarization', sessionId: agent.id, signal,
      };
      for await (const chunk of ctx.llm.stream(request)) assembler.push(chunk);
      signal.throwIfAborted();
      if (['error', 'aborted', 'max-tokens'].includes(assembler.finish.kind)) {
        throw new LlmError(assembler.finish.failure?.message ?? `交接总结未完整生成：${assembler.finish.kind}`,
          assembler.finish.failure?.code ?? (signal.reason?.name === 'TimeoutError' ? 'TIMEOUT' : 'HANDOFF_SUMMARY_INCOMPLETE'));
      }
      return parseSummary(assembler.blocks().filter((block) => block.type === 'text').map((block) => block.text).join(''));
    },
    async title(agent) {
      return (await ctx.sessionQuery.readTitle(agent.id))?.title ?? '会话';
    },
    async hasMessage(id, messageId) {
      try {
        const result = await ctx.sessionQuery.readSession(id);
        return result.events.some((event) => event.data?.id === messageId ||
          (event.type === 'agent/inbox/spliced' && event.data.inserted?.some((message) => message.id === messageId)));
      } catch (error) {
        if (error.code === 'SESSION_QUERY_SESSION_NOT_FOUND') return false;
        throw error;
      }
    },
    async create(source, record) {
      const workspace = ctx.workspaceRegistry.list().find((entry) => entry.sessionIds.includes(source.id));
      const agentPreset = ctx.sessionProjections.stateOf(source.session, 'agentPreset');
      await ctx.sessionController.create({ sessionId: record.nextSessionId,
        ...(workspace ? { workspaceId: workspace.id } : { cwd: source.session.header.cwd }),
        ...(agentPreset ? { agentPreset } : {}),
      });
      const target = ctx.agents.get(record.nextSessionId);
      if (!target) throw new Error('新会话创建后没有可用的执行器。');
      const model = selectedModel(ctx, source);
      // This Beta's controller owns the live model-selection cache as well as
      // model/selection. Avoid selectModel(), which also changes the global default.
      if (typeof ctx.sessionController.agents?.selectForNextRequest !== 'function') {
        throw new Error('当前 DSH 版本不支持会话模型交接，请更新插件适配。');
      }
      ctx.sessionController.agents.selectForNextRequest(target, model);
      Object.assign(target.options, source.options, model);
      const permissions = ctx.sessionProjections.stateOf(source.session, 'permissions');
      if (permissions?.sandbox) setSandboxMode(target.session, permissions.sandbox);
      if (permissions?.approval) setApprovalPolicy(target.session, permissions.approval);
      if (permissions?.preset) target.session.append('permission/preset', { preset: permissions.preset });
      const sourcePlan = source.ctx.get('planMode') ?? ctx.get('planMode');
      const targetPlan = target.ctx.get('planMode') ?? ctx.get('planMode');
      if (sourcePlan && targetPlan) {
        const plan = sourcePlan.get(source);
        targetPlan.set(target, plan.pending ?? plan.active);
      }
      ctx.sessionTitle.rename(target.session, fitTitle(record.nextTitle, ctx.sessionTitle.config.maxTitleBytes));
      return target;
    },
    deliver(target, record) {
      const attachments = ctx.get('attachments');
      const fs = target.ctx?.get('fs') ?? ctx.get('fs');
      // Text-only routes strip native image blocks before adapter projection.
      // Persist a model-visible tool path as well as the UI's native reference.
      const imageHandles = (record.attachments ?? []).filter(block => block.type === 'image').map(block =>
        offloadedImageText(block.attachment, attachments && fs
          ? resolveImageAttachmentAccess(attachments, path => fs.processPathFromHostPath(path), block.attachment) : undefined)).join('\n');
      const message = {
        id: record.messageId, role: 'user',
        source: { kind: record.hasUnfinishedTask ? 'plugin:dsh-session-handoff' : 'plugin:dsh-session-handoff:record-only' },
        content: [{ type: 'text', text: `上一会话任务交接\n\n${record.summary}${imageHandles ? `\n\n原图片读取位置（只读）：\n${imageHandles}` : ''}\n\n${record.hasUnfinishedTask
          ? '请接着完成上述未完成的任务，避免重复已经完成的操作。'
          : '最后一个任务已经完成。保存这份记录，等待用户的新消息。'}` }, ...(record.attachments ?? [])],
      };
      target.followup(message);
    },
    async flush(id) {
      const session = ctx.sessions.get(id);
      if (session) await ctx.sessions.flush(session);
      await ctx.sessionPersistence.flush();
    },
    warn: (message) => ctx.logger.warn(message),
  };
}

export function apply(ctx) {
  ctx.sessionProjections.register(compactionProjection);
  const coordinator = new HandoffCoordinator(makeHost(ctx), new Journal(join(resolveDshHome(), 'plugin-data', 'session-handoff')));
  ctx.on('session/event', (session, event) => coordinator.onEvent(session, event));
  ctx.on('agent/status', ({ agent, status }) => { if (status === 'idle') coordinator.onIdle(agent.id); });
  ctx.effect(() => () => coordinator.dispose());
  coordinator.recover().catch((error) => ctx.logger.warn(`session-handoff startup recovery: ${error.message}`));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/session-handoff/status',
    async handler(req, res) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'GET') { res.statusCode = 405; res.end(JSON.stringify({ error: 'GET required' })); return; }
      const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
      if (!sessionId || sessionId.length > 256) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid sessionId' })); return; }
      try { res.end(JSON.stringify(await coordinator.status(sessionId))); }
      catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
    },
  }));
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact', path: '/api/session-handoff/retry',
    async handler(req, res) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      if (req.method !== 'POST') { res.statusCode = 405; res.end(JSON.stringify({ error: 'POST required' })); return; }
      const sessionId = new URL(req.url, 'http://localhost').searchParams.get('sessionId');
      if (!sessionId || sessionId.length > 256) { res.statusCode = 400; res.end(JSON.stringify({ error: 'Invalid sessionId' })); return; }
      try { res.end(JSON.stringify(await coordinator.retry(sessionId))); }
      catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) })); }
    },
  }));
}
