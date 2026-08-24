(() => {
  const counterEl = document.getElementById('counter');
  const buttonEl = document.getElementById('increment');
  const decrementEl = document.getElementById('decrement');
  const statusEl = document.getElementById('status');
  const resetToggleEl = document.getElementById('resetToggle');
  const resetFormEl = document.getElementById('resetForm');
  const resetValueEl = document.getElementById('resetValue');
  const resetPasswordEl = document.getElementById('resetPassword');

  let ws = null;
  let reconnectDelay = 1000;
  let currentCount = null;
  let widthFloor = 0;

  // serverCount: last absolute value the server told us. pendingActions: this
  // client's own increment/decrement requests not yet confirmed, keyed by a
  // request id so each can be reconciled individually regardless of the order
  // confirmations arrive in. Displayed value is always serverCount + the sum
  // of still-pending deltas, which stays stable across reconciliation (each
  // pending delta is removed from the sum at the exact moment it's folded
  // into serverCount) even under concurrent multi-client traffic.
  let serverCount = null;
  let pendingActions = new Map();
  let nextRequestId = 1;

  function pendingDelta() {
    let total = 0;
    for (const delta of pendingActions.values()) total += delta;
    return total;
  }

  function render(animate) {
    if (serverCount === null) return;
    setCount(serverCount + pendingDelta(), animate);
  }

  function applyLayout(next, forceExactFit, animate) {
    // offsetWidth (not getBoundingClientRect) so the lava glow's transform: scale()
    // never pollutes the measurement if it's still mid-animation
    const startWidth = counterEl.offsetWidth;
    counterEl.textContent = String(next);
    counterEl.style.fontSize = '';
    counterEl.style.width = 'auto';

    // shrink the font if the digit string is too wide to fit the viewport at the
    // default clamp()-based size, so a very large count never overflows off-screen
    const maxWidth = window.innerWidth * 0.86;
    let naturalWidth = counterEl.offsetWidth;
    if (naturalWidth > maxWidth && naturalWidth > 0) {
      const baseSize = parseFloat(getComputedStyle(counterEl).fontSize);
      counterEl.style.fontSize = `${baseSize * (maxWidth / naturalWidth)}px`;
      naturalWidth = counterEl.offsetWidth;
    }

    const endWidth = forceExactFit ? naturalWidth : Math.max(naturalWidth, widthFloor);
    widthFloor = endWidth;

    counterEl.style.width = `${startWidth}px`;
    // force reflow so the browser registers the start width before animating to the end width
    void counterEl.offsetWidth;
    counterEl.style.width = `${endWidth}px`;

    if (animate) {
      counterEl.classList.remove('lava');
      // force reflow so the animation restarts even on rapid successive updates
      void counterEl.offsetWidth;
      counterEl.classList.add('lava');
    }
  }

  function setCount(next, animate) {
    if (currentCount === next) return;
    const decreased = currentCount !== null && next < currentCount;
    currentCount = next;
    counterEl.classList.remove('placeholder');
    applyLayout(next, decreased, animate);
  }

  // re-fit font size and box width on rotation/resize, ignoring the grow-only
  // width floor since the old floor was measured against a different viewport
  window.addEventListener('resize', () => {
    if (currentCount === null) return;
    widthFloor = 0;
    applyLayout(currentCount, true, false);
  });

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
      decrementEl.disabled = false;
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
        serverCount = msg.count;
        pendingActions.clear();
        render(true);
        setStatus('live');
      } else if (msg.type === 'update') {
        serverCount = msg.count;
        if (msg.id !== undefined) pendingActions.delete(msg.id);
        render(true);
      } else if (msg.type === 'error') {
        if (msg.id !== undefined) pendingActions.delete(msg.id);
        render(false);
      } else if (msg.type === 'reset-denied') {
        resetFormEl.hidden = false;
        resetPasswordEl.classList.add('invalid');
        resetPasswordEl.focus();
      }
    });

    ws.addEventListener('close', () => {
      buttonEl.disabled = true;
      decrementEl.disabled = true;
      // any actions still pending on this socket will never get a response;
      // drop them and let the next 'init' re-sync from scratch
      pendingActions.clear();
      setStatus('reconnecting…', true);
      setTimeout(connect, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 1.5, 10000);
    });

    ws.addEventListener('error', () => {
      ws.close();
    });
  }

  buttonEl.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN && serverCount !== null) {
      const id = nextRequestId++;
      pendingActions.set(id, 1);
      render(true);
      ws.send(JSON.stringify({ type: 'increment', id }));
    }
  });

  decrementEl.addEventListener('click', () => {
    if (ws && ws.readyState === WebSocket.OPEN && serverCount !== null) {
      const id = nextRequestId++;
      pendingActions.set(id, -1);
      render(true);
      ws.send(JSON.stringify({ type: 'decrement', id }));
    }
  });

  resetToggleEl.addEventListener('click', () => {
    resetFormEl.hidden = !resetFormEl.hidden;
    if (!resetFormEl.hidden) resetPasswordEl.focus();
  });

  resetPasswordEl.addEventListener('input', () => {
    resetPasswordEl.classList.remove('invalid');
  });

  resetFormEl.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    const password = resetPasswordEl.value;
    if (!password) return;
    const rawValue = resetValueEl.value.trim();
    const value = rawValue === '' ? 0 : Number(rawValue);
    if (!Number.isInteger(value)) return;
    ws.send(JSON.stringify({ type: 'reset', password, value }));
    resetFormEl.hidden = true;
    resetPasswordEl.value = '';
    resetValueEl.value = '';
  });

  buttonEl.disabled = true;
  decrementEl.disabled = true;
  connect();
})();
