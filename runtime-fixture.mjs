import { pathToFileURL } from 'node:url';
import { join, resolve } from 'node:path';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createRequire, registerHooks } from 'node:module';

// Installed DSH core with an optional isolated JSONL root; no user profile,
// tools, credentials, or network adapter is loaded.
const coreRoot = process.env.DSH_TEST_CORE_ROOT ?? 'C:/Users/Administrator/AppData/Local/Programs/DSH Desktop Beta/resources/app/node_modules/@deepseek-ai';
const core = (name, file = 'index.js') => import(pathToFileURL(join(coreRoot, name, 'lib', file)).href);
const installedRequire = createRequire(join(coreRoot, 'cordis', 'package.json'));
const resolver = registerHooks({ resolve(specifier, context, next) {
  try { return next(specifier, context); }
  catch (error) {
    if (error.code !== 'ERR_MODULE_NOT_FOUND' || specifier.startsWith('.') || specifier.startsWith('node:')) throw error;
    return { url: pathToFileURL(installedRequire.resolve(specifier)).href, shortCircuit: true };
  }
} });
const { Context } = await core('cordis');
const { LlmAdapter, createUserMessage } = await core('dsh-llm');
const { makeHost, compactionProjection } = await import('./index.js');
const { ApiSessionAgentController } = await core('dsh-api-session-controller', 'types/agent.js');
const { SessionCommandController } = await core('dsh-api-session-controller', 'types/commands.js');
const { ApiSessionList } = await core('dsh-api-session-controller', 'types/list.js');
const { installModelSelectionProjection } = await core('dsh-api-session-controller', 'types/model-selection-projection.js');
const route = { provider: 'handoff-test', model: 'deterministic' };

async function fixture({ files: existingFiles, persistence = false, maxTitleBytes = 160, attachments = false } = {}) {
  const ctx = new Context();
  const files = existingFiles ?? await mkdtemp(join(tmpdir(), 'dsh-handoff-core-'));
  for (const [name, config] of [
    ['dsh-session-projection', {}], ['dsh-session', {}], ['dsh-llm', {}],
    ['dsh-system-prompt', { includeHarnessIdentity: false, includeRuntimeContext: false }],
    ['dsh-tools', { mode: 'native' }], ['dsh-agent', {}],
    ['dsh-agent-loop', { agents: [] }], ['dsh-token-meter', {}],
    ['dsh-compaction-basic', { auto: false, compactionRetries: 0 }],
    ['dsh-session-title', { fallbackMaxWords: 5, fallbackMaxBytes: 40, maxTitleBytes }],
    ['dsh-session-query', {}], ['dsh-agent-default-model', route], ['dsh-typert-registry', {}],
  ]) await ctx.plugin((await core(name)).default, config);
  if (persistence) await ctx.plugin((await core('dsh-session-persistence-jsonl')).default,
    { root: join(files, 'sessions'), compression: 'none' });
  if (attachments) await ctx.plugin((await core('dsh-attachment-local')).default, { dshHome: files });
  await ctx.plugin((await core('dsh-invariants')).default, {});
  await ctx.plugin(await core('dsh-session', 'invariant.js'));
  const adapter = new class extends LlmAdapter {
    calls = [];
    unfinished = true;
    failCompaction = false;
    held = null;
    contextWindow = 1000000;
    summaryFailure = null;
    replyText = null;
    inputModalities = undefined;
    compactionText = '测试任务摘要。';
    async resolveModel(provider, model) {
      return { provider, id: model, name: model, ...(this.contextWindow == null ? {} : { context: { contextWindow: this.contextWindow } }),
        ...(this.inputModalities ? { inputModalities: this.inputModalities } : {}) };
    }
    async *stream(options) {
      this.calls.push(options);
      if (options.purpose === 'summarization' && this.summaryFailure) {
        yield { type: 'finish', reason: { kind: 'error', failure: this.summaryFailure } };
        return;
      }
      if (options.purpose === 'compaction' && this.failCompaction) {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'TEST_FAILURE', message: 'deliberate compaction failure' } } };
        return;
      }
      if (this.held && options.purpose !== 'compaction' && options.purpose !== 'summarization') await this.held.promise;
      const text = options.purpose === 'compaction' ? this.compactionText : options.purpose === 'summarization'
        ? JSON.stringify({ hasUnfinishedTask: this.unfinished, summary: '保留当前测试任务、工作目录、已完成内容与后续执行步骤。' })
        : this.replyText ?? '测试模型回复已完成。';
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'finish', reason: { kind: 'stop' } };
    }
  }();
  ctx.llm.registerAdapter([route.provider], adapter);
  installModelSelectionProjection(ctx);
  new ApiSessionList(ctx);
  // The actual controller command/agent implementation, without unrelated HTTP,
  // file upload and native-open services. No filesystem workspace is registered.
  ctx.provide('workspaceRegistry', { list: () => [], get: () => undefined });
  const controllers = new ApiSessionAgentController(ctx);
  const commands = new SessionCommandController(ctx, controllers, resolve(files));
  ctx.provide('sessionController', { agents: controllers, create: request => commands.create(request) });
  ctx.on('session/event', (session, event) => {
    if (event.type === 'request/header') {
      const config = event.data.header.config;
      const agent = ctx.agents.get(session.id);
      if (agent) controllers.consumeSelection(agent, config.provider, config.model, config.reasoningEffort);
    }
  });
  return { ctx, adapter, files, close: () => ctx.fiber.dispose() };
}


export { fixture, makeHost, compactionProjection, createUserMessage, route, core as native };
