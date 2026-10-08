// Runs the shipped component in Chromium with DSH's own React renderer.
// Only network, time, storage, and the session service are substituted.
export async function runClientTests(source, React, ReactDOM) {
  const pause = async () => {
    for (let i = 0; i < 16; i++) await new Promise(resolve => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); channel.port2.close(); resolve(); };
      channel.port2.postMessage(null);
    });
  };
  const results = [];
  const check = (condition, message) => { if (!condition) throw new Error(message); };
  async function fixture() {
    const frame = document.createElement('iframe');
    frame.style.cssText = 'width:1100px;height:160px;border:0';
    document.body.appendChild(frame);
    const w = frame.contentWindow;
    let hidden = false, count = 0, component, props, current = 'source', status = 'idle', response;
    let now = Date.now(), serial = 0;
    const timers = new Map(), calls = [], navigations = [], storage = new Map();
    Object.defineProperty(w, 'localStorage', { value: { getItem: key => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) } });
    Object.defineProperty(w.document, 'hidden', { get: () => hidden });
    w.Date.now = () => now;
    w.setTimeout = (fn, ms) => { const id = ++serial; timers.set(id, { fn, due: now + ms }); return id; };
    w.clearTimeout = id => timers.delete(id);
    response = () => ({ sessionId: props.sessionId, count, phase: 'watching', canPause: true });
    w.fetch = async (url, options) => {
      calls.push({ url, method: options.method });
      const data = await response(url, options);
      return { ok: true, json: async () => data };
    };
    const translations = {};
    w.__ModuleLoader__ = { load(registration) {
      registration.factory(name => { if (name === 'react') return React; throw new Error(name); }).apply({
        effect(fn) { fn(); }, locale: { register(_namespace, values) { Object.assign(translations, values.zh); return () => {}; } },
        slots: { inject(_slot, fn) { fn(); }, register(_options, value) { component = value; return () => {}; } },
        sessions: { list: { getSnapshot: () => ({ byId: { [current]: { id: current, status, retainedBy: { mainView: 1 } } } }) } },
        uiWorkspace: { openSession(id) { navigations.push(id); current = id; } },
      });
    } };
    w.eval(source);
    const host = w.document.createElement('div'); w.document.body.appendChild(host);
    let root = ReactDOM.createRoot(host);
    const t = (key, values = {}) => (translations[key] ?? key).replace(/\{(\w+)\}/gu, (_match, name) => values[name]);
    const useProjection = () => count;
    async function render(sessionId = 'source') {
      props = { sessionId, t, useProjection }; root.render(React.createElement(component, props)); await pause();
    }
    return { host, calls, navigations, timers, render,
      async remount(sessionId = 'source') {
        root.unmount(); await pause();
        w.eval(source); root = ReactDOM.createRoot(host); await render(sessionId);
      },
      setResponse(fn) { response = fn; }, setCount(value) { count = value; }, setCurrent(value) { current = value; },
      setStatus(value) { status = value; }, now: () => now,
      async hidden(value) { hidden = value; w.document.dispatchEvent(new w.Event('visibilitychange')); await pause(); },
      async tick(ms) { now += ms; for (const [id, timer] of [...timers]) if (timer.due <= now) { timers.delete(id); timer.fn(); } await pause(); },
      async click(label) { const button = [...host.querySelectorAll('button')].find(item => item.textContent === label); check(button, `Missing button: ${label}`); button.click(); await pause(); },
      async close() { root.unmount(); await pause(); frame.remove(); },
    };
  }
  async function run(name, fn) {
    const f = await fixture();
    try { await fn(f); results.push({ name, pass: true }); }
    finally { await f.close(); }
  }
  await run('watching polls slowly; threshold refreshes; hidden pauses; visible resumes; done stops', async f => {
    await f.render(); check(f.calls.length === 1, 'initial request');
    await f.tick(2000); check(f.calls.length === 1, 'watching polled too soon');
    f.setCount(3); await f.render(); check(f.calls.length === 2, 'threshold did not refresh');
    await f.hidden(true); const before = f.calls.length; await f.tick(60000); check(f.calls.length === before, 'hidden page polled');
    await f.hidden(false); check(f.calls.length === before + 1, 'visible did not refresh');
    f.setResponse(() => ({ sessionId: 'source', count: 3, phase: 'done', nextSessionId: 'next', transferredAt: f.now() }));
    await f.tick(2000); check(f.navigations.join() === 'next', 'source did not navigate once');
    const done = f.calls.length; await f.tick(60000); check(f.calls.length === done, 'done kept polling');
  });
  await run('rapid session switch ignores late old response', async f => {
    let release; f.setResponse(() => new Promise(resolve => { release = resolve; })); await f.render();
    f.setResponse(() => ({ sessionId: 'other', count: 1, phase: 'watching' })); f.setCurrent('other'); await f.render('other');
    release({ sessionId: 'source', count: 3, phase: 'done', nextSessionId: 'stale', transferredAt: f.now() });
    await pause(); check(f.navigations.length === 0, 'stale response navigated');
    check(f.host.querySelector('span').dataset.sessionId === 'other', 'old badge survived');
  });
  await run('offline recovers and handoff retry posts to the correct endpoint', async f => {
    f.setResponse(() => { throw new TypeError('offline'); }); await f.render();
    check(f.host.querySelector('span').dataset.state === 'unavailable', 'offline state missing');
    f.setResponse((_url, options) => ({ sessionId: 'source', count: 3, phase: options.method === 'POST' ? 'pending' : 'error', error: 'temporary failure' }));
    await f.tick(10000); await f.click('重试交接');
    check(f.calls.at(-1).method === 'POST' && f.calls.at(-1).url.includes('/retry?'), 'incorrect retry request');
    check(f.host.querySelector('span').dataset.state === 'pending', 'retry response missing');
  });
  await run('historical sessions remain readable and expose an explicit continuation button', async f => {
    f.setResponse(() => ({ sessionId: 'source', count: 3, phase: 'done', nextSessionId: 'old-next', transferredAt: f.now() - 1000 }));
    await f.render(); await f.render('other'); await f.render('source'); await f.remount();
    check(f.navigations.length === 0, 'historical session redirected');
    await f.click('打开续接会话'); check(f.navigations.join() === 'old-next', 'explicit open failed');
  });
  await run('remount during pending handoff follows a newly completed target once', async f => {
    f.setCount(3); f.setResponse(() => ({ sessionId: 'source', count: 3, phase: 'pending' })); await f.render();
    await f.remount();
    f.setResponse(() => ({ sessionId: 'source', count: 3, phase: 'done', nextSessionId: 'new-next', transferredAt: f.now() + 1 }));
    await f.tick(2000); check(f.navigations.join() === 'new-next', 'pending navigation lost');
  });
  await run('terminal and exhausted errors poll every ten seconds and honor canPause=false', async f => {
    f.setResponse(() => ({ sessionId: 'source', count: 3, phase: 'error', error: 'permanent failure', canPause: false }));
    await f.render(); check(f.host.querySelectorAll('button').length === 1, 'committed error exposed a no-op pause');
    await f.tick(2000); check(f.calls.length === 1, 'terminal error polled at 2 seconds');
    await f.tick(8000); check(f.calls.length === 2, 'terminal error did not poll at 10 seconds');
  });
  await run('retry countdown updates locally and pauses its timer while hidden', async f => {
    const retryAt = f.now() + 5000;
    f.setResponse(() => ({ sessionId: 'source', count: 3, phase: 'error', retryAt })); await f.render();
    check(f.host.textContent.includes('5 秒后重试'), 'initial countdown missing');
    await f.tick(1000); check(f.host.textContent.includes('4 秒后重试') && f.calls.length === 1, 'countdown caused a request');
    await f.hidden(true); const calls = f.calls.length; await f.tick(3000); check(f.calls.length === calls, 'hidden countdown polled');
    await f.hidden(false); check(f.host.textContent.includes('1 秒后重试'), 'visible countdown stale');
  });
  await run('pause and resume use POST and keep the badge in sync', async f => {
    let paused = false;
    f.setResponse(url => {
      if (url.includes('/pause?')) paused = true;
      if (url.includes('/resume?')) paused = false;
      return { sessionId: 'source', count: 2, phase: paused ? 'paused' : 'watching', canPause: true };
    });
    await f.render(); await f.click('暂停交接');
    check(f.calls.at(-1).method === 'POST' && f.host.querySelector('span').dataset.state === 'paused', 'pause failed');
    await f.remount(); check(f.host.querySelector('span').dataset.state === 'paused', 'pause lost after root remount');
    const calls = f.calls.length; await f.tick(2000); check(f.calls.length === calls, 'paused polled too soon');
    await f.click('恢复交接');
    check(f.calls.at(-1).method === 'POST' && f.calls.at(-1).url.includes('/resume?'), 'resume failed');
  });
  await run('automatic navigation waits for routing to settle the old source', async f => {
    f.setStatus('running');
    f.setResponse(() => ({ sessionId: 'source', count: 3, phase: 'done', nextSessionId: 'settled-next', transferredAt: f.now() + 1 }));
    await f.render(); check(f.navigations.length === 0, 'running source navigated early');
    await f.tick(2000); check(f.navigations.length === 0 && f.calls.length === 2, 'pending navigation stopped polling');
    f.setStatus('idle'); await f.tick(2000); check(f.navigations.join() === 'settled-next', 'settled source never navigated');
  });
  await run('Goal and subagent deferrals explain why handoff waits', async f => {
    f.setResponse(() => ({ sessionId: 'source', count: 3, phase: 'deferred', reason: 'goal' })); await f.render();
    check(f.host.querySelector('span').title.includes('Goal 尚未结束'), 'Goal reason missing');
    f.setResponse(() => ({ sessionId: 'source', count: 3, phase: 'deferred', reason: 'subagents' })); await f.tick(10000);
    check(f.host.querySelector('span').title.includes('等待子代理'), 'subagent reason missing');
  });
  return results;
}
