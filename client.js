window.__ModuleLoader__.load({
  id: '@local/dsh-session-handoff',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const NS = 'session-handoff';

    return {
      inject: ['slots', 'uiWorkspace', 'sessions', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, {
          zh: {
            count: '已压缩 {count} 次',
            loading: '压缩次数加载中…',
            pending: '待交接',
            summarizing: '正在交接',
            'handed-off': '已交接',
            error: '交接失败',
            unavailable: '读取失败',
            hint: '累计压缩 3 次后，等待当前一轮回复结束，交接到新会话。',
            requestError: '无法读取压缩次数（HTTP {status}）。',
            invalidResponse: '压缩次数响应无效。',
            retry: '重试交接',
            retrying: '正在重试…',
            committing: '正在保存交接',
            deferred: '暂缓交接',
            goal: 'Goal 尚未结束，保留原会话及停止条件。',
            subagents: '等待子代理完成并处理结果。',
            paused: '已暂停交接',
            pause: '暂停交接',
            resume: '恢复交接',
            open: '打开续接会话',
            countdown: '{seconds} 秒后重试',
          },
          en: {
            count: 'Compacted {count} times',
            loading: 'Loading compaction count…',
            pending: 'Handoff pending',
            summarizing: 'Handing off',
            'handed-off': 'Handed off',
            error: 'Handoff failed',
            unavailable: 'Unavailable',
            hint: 'After 3 compactions, wait for the current response to finish, then hand off to a new session.',
            requestError: 'Cannot load the compaction count (HTTP {status}).',
            invalidResponse: 'Invalid compaction count response.',
            retry: 'Retry handoff',
            retrying: 'Retrying…',
            committing: 'Saving handoff',
            deferred: 'Handoff deferred',
            goal: 'Keep the unfinished Goal and its stop conditions in this session.',
            subagents: 'Waiting for subagents and their results.',
            paused: 'Handoff paused',
            pause: 'Pause handoff',
            resume: 'Resume handoff',
            open: 'Open continuation',
            countdown: 'Retry in {seconds}s',
          },
        }));

        // Retain a memory fallback if browser storage is unavailable.
        const handled = new Set();
        const marker = (source, target) => `dsh-session-handoff:handled:${source}:${target}`;
        function isHandled(key) {
          if (handled.has(key)) return true;
          try { return localStorage.getItem(key) === '1'; } catch { return false; }
        }
        function markHandled(key) {
          handled.add(key);
          try { localStorage.setItem(key, '1'); } catch {}
        }

        function HandoffStatus({ sessionId, t, useProjection }) {
          const liveCount = useProjection('sessionHandoffCompactions', (state) => state?.count);
          const [view, setView] = React.useState(null);
          const [retrying, setRetrying] = React.useState(false);
          const [now, setNow] = React.useState(Date.now);
          const refreshRef = React.useRef();
          const retryRef = React.useRef();

          React.useEffect(() => {
            let disposed = false;
            let timer;
            let request;
            let firstResult = true;
            let serial = 0;
            let lastPhase;
            let lastCount = 0;
            let retryAt;
            let navigationPending = false;
            const mountedAt = Date.now();
            setView(null);
            setRetrying(false);
            if (!sessionId) return;

            function maybeNavigate(data) {
              navigationPending = false;
              if (data.phase !== 'done' || typeof data.nextSessionId !== 'string' ||
                  !data.nextSessionId || data.nextSessionId === sessionId) return;
              const key = marker(sessionId, data.nextSessionId);
              if (isHandled(key)) return;
              // Historical sessions remain readable when deliberately reopened.
              const createdAt = typeof data.transferredAt === 'number'
                ? data.transferredAt : Date.parse(data.transferredAt);
              if (firstResult && !(createdAt >= mountedAt)) {
                markHandled(key);
                return;
              }
              const current = Object.values(ctx.sessions.list.getSnapshot().byId)
                .find((row) => (row.retainedBy?.mainView ?? 0) > 0);
              if (current?.id !== sessionId) return;
              // Forwarding settles the old driver's empty turn first. Keep its
              // input visible until routing has finished, then open the target.
              if (current.status === 'running') { navigationPending = true; return; }
              markHandled(key);
              try {
                ctx.uiWorkspace.openSession(data.nextSessionId);
              } catch (error) {
                handled.delete(key);
                try { localStorage.removeItem(key); } catch {}
                throw error;
              }
            }

            async function refresh(action = 'status') {
              const manual = action !== 'status';
              if (disposed || (!manual && document.hidden)) return;
              clearTimeout(timer);
              request?.abort();
              const generation = ++serial;
              const controller = request = new AbortController();
              const timeout = setTimeout(() => controller.abort(), 10000);
              let unavailable = false;
              if (manual) setRetrying(true);
              try {
                const response = await fetch(`/api/session-handoff/${action}?sessionId=${encodeURIComponent(sessionId)}`, {
                  method: manual ? 'POST' : 'GET',
                  signal: controller.signal,
                  credentials: 'same-origin',
                  headers: { Accept: 'application/json' },
                });
                if (!response.ok) throw new Error(t('requestError', { status: response.status }));
                const data = await response.json();
                if (disposed || generation !== serial) return;
                if (data.sessionId !== sessionId || !Number.isSafeInteger(data.count) || data.count < 0 ||
                    !['watching', 'pending', 'summarizing', 'committing', 'done', 'error', 'deferred', 'paused'].includes(data.phase)) {
                  throw new Error(t('invalidResponse'));
                }
                const next = {
                  sessionId,
                  count: data.count,
                  status: { watching: 'idle', done: 'handed-off' }[data.phase] || data.phase,
                  error: typeof data.error === 'string' ? data.error : '',
                  retryAt: typeof data.retryAt === 'number' ? data.retryAt : undefined,
                  nextSessionId: typeof data.nextSessionId === 'string' ? data.nextSessionId : undefined,
                  reason: typeof data.reason === 'string' ? data.reason : '',
                  canPause: data.canPause !== false,
                };
                lastPhase = data.phase;
                lastCount = data.count;
                retryAt = next.retryAt;
                setView((old) => old?.sessionId === sessionId && old.count === next.count &&
                  old.status === next.status && old.error === next.error && old.retryAt === next.retryAt &&
                  old.nextSessionId === next.nextSessionId && old.reason === next.reason && old.canPause === next.canPause && !old.unavailable ? old : next);
                maybeNavigate(data);
                firstResult = false;
              } catch (error) {
                if (disposed || generation !== serial) return;
                unavailable = true;
                setView((old) => ({
                  ...(old?.sessionId === sessionId ? old : { sessionId, count: null, status: 'idle' }),
                  unavailable: true,
                  error: error instanceof Error ? error.message : String(error),
                }));
              } finally {
                clearTimeout(timeout);
                if (!disposed && generation === serial) {
                  setRetrying(false);
                  if (!document.hidden && (unavailable || lastPhase !== 'done' || navigationPending)) {
                    const fast = !unavailable && (navigationPending || ['pending', 'summarizing', 'committing'].includes(lastPhase) ||
                      lastPhase === 'error' && retryAt || lastPhase === 'watching' && lastCount >= 3);
                    timer = setTimeout(() => refresh(), fast ? 2000 : 10000);
                  }
                }
              }
            }

            const visibility = () => {
              clearTimeout(timer);
              if (!document.hidden && (lastPhase !== 'done' || navigationPending)) refresh();
            };
            refreshRef.current = () => { if (lastPhase !== 'done') refresh(); };
            retryRef.current = action => refresh(action);
            document.addEventListener('visibilitychange', visibility);
            refresh();
            return () => {
              disposed = true;
              refreshRef.current = undefined;
              retryRef.current = undefined;
              document.removeEventListener('visibilitychange', visibility);
              clearTimeout(timer);
              request?.abort();
            };
          }, [sessionId, t]);
          React.useEffect(() => { if (liveCount >= 3) refreshRef.current?.(); }, [liveCount]);
          React.useEffect(() => {
            if (!view?.retryAt) return;
            let timer;
            const tick = () => {
              setNow(Date.now());
              if (!document.hidden) timer = setTimeout(tick, 1000);
            };
            const visibility = () => { clearTimeout(timer); if (!document.hidden) tick(); };
            visibility();
            document.addEventListener('visibilitychange', visibility);
            return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', visibility); };
          }, [sessionId, view?.retryAt]);

          const current = view?.sessionId === sessionId ? view : null;
          const status = current?.unavailable ? 'unavailable' : current?.status;
          const count = Number.isSafeInteger(liveCount) && liveCount >= 0
            ? Math.max(liveCount, current?.count ?? 0) : current?.count;
          const label = count != null ? t('count', { count }) : t('loading');
          const suffix = (status && status !== 'idle' ? ` · ${t(status)}` : '') +
            (current?.retryAt && !current.unavailable ? ` · ${t('countdown', { seconds: Math.max(0, Math.ceil((current.retryAt - now) / 1000)) })}` : '');
          const button = (label, action) => h('button', {
            type: 'button', disabled: retrying, onClick: action,
            style: { marginLeft: 6, cursor: retrying ? 'wait' : 'pointer', color: 'inherit', font: 'inherit' },
          }, t(label));
          return h('span', {
            className: 'dsh-session-handoff-status',
            'data-session-id': sessionId,
            'data-state': status || 'loading',
            role: 'status',
            'aria-live': 'polite',
            'aria-atomic': true,
            title: `${t('hint')}${current?.reason ? `\n${t(current.reason)}` : ''}${current?.error ? `\n${current.error}` : ''}`,
            style: {
              order: 10,
              display: 'inline-flex',
              alignItems: 'center',
              flexShrink: 0,
              color: 'var(--dsw-alias-label-tertiary)',
              fontSize: 13,
              lineHeight: '20px',
              whiteSpace: 'nowrap',
              cursor: 'default',
            },
          }, label + suffix,
          status === 'error' ? button(retrying ? 'retrying' : 'retry', () => retryRef.current?.('retry')) : null,
          current?.canPause && !current.unavailable && !['handed-off', 'committing'].includes(status)
            ? button(status === 'paused' ? 'resume' : 'pause', () => retryRef.current?.(status === 'paused' ? 'resume' : 'pause')) : null,
          status === 'handed-off' && current.nextSessionId && current.nextSessionId !== sessionId
            ? button('open', () => ctx.uiWorkspace.openSession(current.nextSessionId)) : null);
        }

        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'session-handoff',
          order: 100,
          locale: NS,
        }, HandoffStatus));
      },
    };
  },
});
