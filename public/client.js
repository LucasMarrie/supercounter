(() => {
  const counterEl = document.getElementById('counter');
  const buttonEl = document.getElementById('increment');
  const statusEl = document.getElementById('status');

  let ws = null;
  let reconnectDelay = 1000;
  let currentCount = null;

  function setCount(next, animate) {
    if (currentCount === next) return;
    currentCount = next;
    counterEl.textContent = String(next);

    if (animate) {
      counterEl.classList.remove('lava');
      // force reflow so the animation restarts even on rapid successive updates
      void counterEl.offsetWidth;
      counterEl.classList.add('lava');
    }
  }

  function setStatus(text, isError) {
    statusEl.textContent = text;
    statusEl.classList.toggle('error', Boolean(isError));
  }

  function connect() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${protocol}//${location.host}`);

    ws.addEventListener('open', () => {
      reconnectDelay = 1000;
      buttonEl.disabled = false;
      setStatus('live');
    });

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }

      if (msg.type === 'init') {
        setCount(msg.count, false);
        setStatus('live');
      } else if (msg.type === 'update') {
        setCount(msg.count, true);
      }
    });

    ws.addEventListener('close', () => {
      buttonEl.disabled = true;
      setStatus('reconnecting…', true);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  buttonEl.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'increment' }));
    }
  });

  buttonEl.disabled = true;
  connect();
})();
