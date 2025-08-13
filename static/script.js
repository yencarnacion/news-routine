/* global jsyaml, marked */
/* eslint-env browser */
/*****************************************************************************************
 * script.js – revamped to preserve generated summaries after streaming completes. *
 * *
 * NEW FEATURES *
 * 1. "Copy Markdown" and "Toggle Raw / Formatted" buttons. *
 * 2. Raw markdown is saved to localStorage so the last run is restored on reload. *
 * 3. Safer parsing that tolerates **bold** headings & falls back to plain markdown. *
 * 4. Dynamic PPLX queries with fixed/template/custom types, loaded from YAML. *
 *****************************************************************************************/
// ----------------------------------------------------------------------------
// UTILITIES
// ----------------------------------------------------------------------------
/**
 * Try to build a structured representation of the summary that the model
 * produced. If anything goes wrong we just return an empty array and the caller
 * can decide to fall back to raw markdown.
 */
function parseSummaries (response) {
  const out = [];
  const lines = response.split(/\r?\n/);
  let currentSource = '';
  let currentItems = [];
  const pushSection = () => {
    if (currentSource) out.push({ source: currentSource, items: currentItems });
    currentSource = '';
    currentItems = [];
  };
  for (let raw of lines) {
    if (!raw.trim()) continue;
    // Remove markdown bold markers on the entire line (e.g. **THE TIMES**)
    const line = raw.replace(/^\*\*(.*?)\*\*$/, '$1').trim();
    // A new source heading is assumed if it's not a bullet and looks SHOUTY.
    if (!line.startsWith('-') && /^[A-Z][A-Z\s&\-]+$/.test(line)) {
      pushSection();
      currentSource = line;
      continue;
    }
    // Bullet → summary item
    if (line.startsWith('- ')) {
      currentItems.push(
        // Preserve "**Mini Title:**" bolding by converting to <strong>
        line.slice(2).replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
      );
    }
  }
  pushSection();
  return out;
}
function copyToClipboard (text) {
  navigator.clipboard.writeText(text).then(
    () => alert('Copied to clipboard'),
    err => alert('Clipboard error: ' + err)
  );
}
// Convert markdown to readable plain text
function markdownToPlainText (md) {
  try {
    const div = document.createElement('div');
    div.innerHTML = marked.parse(md || '');
    const text = (div.textContent || div.innerText || '').replace(/\s+/g, ' ').trim();
    return text;
  } catch (e) {
    return (md || '').replace(/[#*>`_\-]/g, ' ').replace(/\s+/g, ' ').trim();
  }
}
// Minimal spritz-like widget (inspired by Glance-Bookmarklet)
function createSpritzWidget () {
  const root = document.createElement('div');
  root.className = 'spritz';
  const display = document.createElement('div');
  display.className = 'spritz-display';
  const meta = document.createElement('div');
  meta.className = 'spritz-meta';
  const controls = document.createElement('div');
  controls.className = 'spritz-controls';
  const play = document.createElement('button');
  play.className = 'btn btn-sm btn-primary';
  play.textContent = 'Play';
  const wpmLabel = document.createElement('span');
  wpmLabel.textContent = 'WPM';
  const wpm = document.createElement('input');
  wpm.type = 'range';
  wpm.className = 'form-range';
  wpm.min = '150';
  wpm.max = '1000';
  wpm.step = '50';
  wpm.value = '200';
  const wpmVal = document.createElement('span');
  wpmVal.textContent = '200';
  const wpmMinus50 = document.createElement('button');
  wpmMinus50.className = 'btn btn-sm btn-outline-secondary';
  wpmMinus50.textContent = '-50';
  wpmMinus50.title = 'Decrease speed by 50 WPM';
  const wpmPlus50 = document.createElement('button');
  wpmPlus50.className = 'btn btn-sm btn-outline-secondary';
  wpmPlus50.textContent = '+50';
  wpmPlus50.title = 'Increase speed by 50 WPM';
  const prog = document.createElement('input');
  prog.type = 'range';
  prog.className = 'form-range';
  prog.min = '0';
  prog.max = '100';
  prog.step = '1';
  prog.value = '0';
  const skipBack10 = document.createElement('button');
  skipBack10.className = 'btn btn-sm btn-outline-secondary';
  skipBack10.textContent = '-10';
  skipBack10.title = 'Skip backward by 10 words';
  const skipFwd10 = document.createElement('button');
  skipFwd10.className = 'btn btn-sm btn-outline-secondary';
  skipFwd10.textContent = '+10';
  skipFwd10.title = 'Skip forward by 10 words';
  const reset = document.createElement('button');
  reset.className = 'btn btn-sm btn-outline-secondary';
  reset.textContent = 'Reset';
  controls.appendChild(play);
  controls.appendChild(wpmLabel);
  controls.appendChild(wpmMinus50);
  controls.appendChild(wpm);
  controls.appendChild(wpmPlus50);
  controls.appendChild(wpmVal);
  controls.appendChild(skipBack10);
  controls.appendChild(prog);
  controls.appendChild(skipFwd10);
  controls.appendChild(reset);
  root.appendChild(display);
  root.appendChild(controls);
  root.appendChild(meta);

  let words = [];
  let index = 0;
  let timer = null;
  let running = false;

  function pivotIndex (word) {
    const len = word.length;
    if (len <= 1) return 0;
    if (len <= 5) return 1;
    if (len <= 9) return 2;
    if (len <= 13) return 3;
    return 4;
  }
  function renderWord (word) {
    const clean = word.replace(/^[^\w$]+|[^\w%\)]+$/g, '');
    const p = Math.min(pivotIndex(clean), Math.max(0, clean.length - 1));
    const left = clean.slice(0, p);
    const pivot = clean.charAt(p) || '';
    const right = clean.slice(p + 1);
    display.innerHTML = `${left}<span class="orp">${pivot}</span>${right}`;
    meta.textContent = `${index + 1}/${words.length}`;
    prog.value = words.length ? Math.round(((index + 1) / words.length) * 100) : 0;
  }
  function baseDelayMs () {
    return 60000 / parseInt(wpm.value, 10);
  }
  function extraDelay (word) {
    if (/([\.!?])[\)\]"']*$/.test(word)) return 2.0; // full stop
    if (/[,:;][\)\]"']*$/.test(word)) return 1.5; // comma/colon/semicolon
    if (word.length >= 8) return 1.2; // long words
    return 1.0;
  }
  function tick () {
    if (!running) return;
    if (index >= words.length) {
      running = false;
      play.textContent = 'Play';
      return;
    }
    const word = words[index++];
    renderWord(word);
    const delay = baseDelayMs() * extraDelay(word);
    timer = setTimeout(tick, delay);
  }
  function start () {
    if (!words.length) return;
    if (running) return;
    running = true;
    play.textContent = 'Pause';
    tick();
  }
  function pause () {
    running = false;
    play.textContent = 'Play';
    if (timer) { clearTimeout(timer); timer = null; }
  }
  play.addEventListener('click', () => {
    if (running) pause(); else start();
  });
  reset.addEventListener('click', () => {
    pause();
    index = 0;
    display.textContent = '';
    meta.textContent = '';
    prog.value = '0';
  });
  wpm.addEventListener('input', () => {
    wpmVal.textContent = wpm.value;
  });
  function clampWpm (val) {
    const min = parseInt(wpm.min, 10);
    const max = parseInt(wpm.max, 10);
    return Math.max(min, Math.min(max, val));
  }
  function rescheduleIfRunning () {
    if (!running) return;
    if (timer) { clearTimeout(timer); timer = null; }
    timer = setTimeout(tick, baseDelayMs());
  }
  wpmMinus50.addEventListener('click', () => {
    const next = clampWpm(parseInt(wpm.value, 10) - 50);
    wpm.value = String(next);
    wpmVal.textContent = String(next);
    rescheduleIfRunning();
  });
  wpmPlus50.addEventListener('click', () => {
    const next = clampWpm(parseInt(wpm.value, 10) + 50);
    wpm.value = String(next);
    wpmVal.textContent = String(next);
    rescheduleIfRunning();
  });
  function clampIndex (val) {
    if (!words.length) return 0;
    return Math.max(0, Math.min(words.length - 1, val));
  }
  function jumpBy (delta) {
    if (!words.length) return;
    index = clampIndex(index + delta);
    renderWord(words[index]);
    rescheduleIfRunning();
  }
  skipBack10.addEventListener('click', () => jumpBy(-10));
  skipFwd10.addEventListener('click', () => jumpBy(10));
  prog.addEventListener('input', () => {
    if (!words.length) return;
    const pct = parseInt(prog.value, 10) / 100;
    index = Math.floor(pct * words.length);
    if (index >= words.length) index = words.length - 1;
    if (index < 0) index = 0;
    if (!running && words[index]) renderWord(words[index]);
  });
  return {
    root,
    setText: (md) => {
      const text = markdownToPlainText(md || '');
      words = text.split(/\s+/).filter(Boolean);
      index = 0;
      display.textContent = '';
      meta.textContent = words.length ? `0/${words.length}` : '';
      prog.value = '0';
    }
  };
}
// ----------------------------------------------------------------------------
// DOMContentLoaded
// ----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // HTTP HTTP elements
  const summariesDiv = document.getElementById('summaries');
  const rawPre = document.getElementById('raw-markdown');
  const copyBtn = document.getElementById('copy-btn');
  const toggleBtn = document.getElementById('toggle-btn');
  const speedBtn = document.getElementById('speed-btn');
  const newsSpritzHost = document.getElementById('news-spritz');
  const newsSpritz = createSpritzWidget();
  if (newsSpritzHost) newsSpritzHost.appendChild(newsSpritz.root);
  if (speedBtn) speedBtn.addEventListener('click', () => {
    const isHidden = newsSpritzHost.style.display === 'none';
    newsSpritzHost.style.display = isHidden ? 'block' : 'none';
    if (isHidden) newsSpritz.setText(lastFullText || '');
  });
  let lastFullText = '';
  let rawVisible = false;
  let pplxQueries = []; // Store for run logic
  // Component to view markdown with toggle + copy for raw
  function createMarkdownViewer (titleText) {
    const root = document.createElement('div');
    const header = document.createElement('div');
    header.className = 'd-flex align-items-center justify-content-between';
    const title = document.createElement('h3');
    title.textContent = titleText;
    const btns = document.createElement('div');
    const toggle = document.createElement('button');
    toggle.className = 'btn btn-sm btn-outline-secondary me-2';
    toggle.textContent = 'Toggle Raw / Formatted';
    const copy = document.createElement('button');
    copy.className = 'btn btn-sm btn-outline-secondary';
    copy.textContent = 'Copy Raw Markdown';
    const speed = document.createElement('button');
    speed.className = 'btn btn-sm btn-outline-secondary ms-2';
    speed.textContent = 'Speed Read';
    btns.appendChild(toggle);
    btns.appendChild(copy);
    btns.appendChild(speed);
    header.appendChild(title);
    header.appendChild(btns);
    const formatted = document.createElement('div');
    const pre = document.createElement('pre');
    pre.style.display = 'none';
    pre.style.whiteSpace = 'pre-wrap';
    const spritzHost = document.createElement('div');
    spritzHost.style.display = 'none';
    root.appendChild(header);
    root.appendChild(spritzHost);
    root.appendChild(formatted);
    root.appendChild(pre);
    let showRaw = false;
    toggle.addEventListener('click', () => {
      showRaw = !showRaw;
      pre.style.display = showRaw ? 'block' : 'none';
      formatted.style.display = showRaw ? 'none' : 'block';
      toggle.textContent = showRaw ? 'Toggle Formatted View' : 'Toggle Raw / Formatted';
    });
    copy.addEventListener('click', () => copyToClipboard(pre.textContent));
    const spritz = createSpritzWidget();
    spritzHost.appendChild(spritz.root);
    speed.addEventListener('click', () => {
      const isHidden = spritzHost.style.display === 'none';
      spritzHost.style.display = isHidden ? 'block' : 'none';
      if (isHidden) spritz.setText(pre.textContent);
    });
    return {
      root,
      setTitle: (t) => { title.textContent = t; },
      setMarkdown: (md) => {
        formatted.innerHTML = marked.parse(md || '');
        pre.textContent = md || '';
        // Keep spritz text in sync
        if (spritzHost.style.display !== 'none') spritz.setText(md || '');
      }
    };
  }
  //--------------------------------------------------------------------------
  // 1) Load settings.yaml so the UI starts populated
  //--------------------------------------------------------------------------
  fetch('/api/settings')
    .then(r => {
      if (!r.ok) throw new Error('Failed to fetch settings');
      return r.text();
    })
    .then(yaml => {
      const settings = jsyaml.load(yaml);
      // --- news prompt -----------------------------------------------------
      document.getElementById('news-prompt').textContent = settings.news_prompt || '';
      // --- grok prompts ----------------------------------------------------
      const grokDiv = document.getElementById('grok-prompts');
      if (Array.isArray(settings.grok_prompts)) {
        settings.grok_prompts.forEach(prompt => {
          const cb = document.createElement('input');
          cb.type = 'checkbox';
          cb.value = prompt;
          grokDiv.appendChild(cb);
          grokDiv.appendChild(document.createTextNode(prompt));
          grokDiv.appendChild(document.createElement('br'));
        });
      }
      // --- pplx queries (dynamic with types) -------------------------------
      const pplxDiv = document.getElementById('pplx-prompts');
      pplxQueries = settings.pplx_queries || [];
      pplxQueries.forEach((query, index) => {
        const div = document.createElement('div');
        div.className = 'form-check mb-2';
        const cb = document.createElement('input');
        cb.className = 'form-check-input';
        cb.type = 'checkbox';
        cb.id = 'pplx-query-' + index;
        const label = document.createElement('label');
        label.className = 'form-check-label';
        label.htmlFor = cb.id;
        label.textContent = query.label;
        div.appendChild(cb);
        div.appendChild(label);
        if (query.type === 'template' || query.type === 'custom') {
          const ta = document.createElement('textarea');
          ta.id = 'pplx-text-' + index;
          ta.className = 'form-control mt-2 mb-3';
          ta.rows = 3;
          ta.placeholder = query.type === 'custom' ? 'Enter your query here' : 'Enter ' + query.placeholder + ' here';
          ta.disabled = true;
          div.appendChild(ta);
          cb.addEventListener('change', e => {
            ta.disabled = !e.target.checked;
          });
        }
        pplxDiv.appendChild(div);
      });
      // --- raw YAML into textarea -----------------------------------------
      document.getElementById('settings-yaml').value = yaml;
    })
    .catch(err => console.error('Error loading settings:', err));
  //--------------------------------------------------------------------------
  // 2) Restore last summary from localStorage if any
  //--------------------------------------------------------------------------
  if (localStorage.getItem('lastSummaryMarkdown')) {
    lastFullText = localStorage.getItem('lastSummaryMarkdown');
    renderFormatted(lastFullText);
    revealUtilityButtons();
  }
  //--------------------------------------------------------------------------
  // 3) NEWS SUMMARIES ➜ streaming from GPT-4o
  //--------------------------------------------------------------------------
  const generateBtn = document.getElementById('generate-btn');
  if (generateBtn) generateBtn.addEventListener('click', () => {
    const email = document.getElementById('email-content').value.trim();
    if (!email) return;
    // Clear previous run entirely
    summariesDiv.innerHTML = '';
    rawPre.textContent = '';
    rawPre.style.display = 'none';
    hideUtilityButtons();
    fetch('/api/generate-summaries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email })
    })
      .then(response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let fullText = '';
        return pump();
        function pump () {
          return reader.read().then(({ done, value }) => {
            if (done) {
              // Stream finished ▸ finalise rendering & persist result
              if (!fullText) return; // nothing to render
              localStorage.setItem('lastSummaryMarkdown', fullText);
              lastFullText = fullText;
              renderFormatted(fullText);
              revealUtilityButtons();
              return;
            }
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop(); // incomplete line stays in buffer
            lines.forEach(line => {
              if (!line.trim()) return;
              try {
                const event = JSON.parse(line);
                switch (event.type) {
                  case 'prompt':
                    summariesDiv.innerHTML = `<p><em>${event.content}</em></p>`;
                    break;
                  case 'chunk':
                    fullText += event.content;
                    summariesDiv.innerHTML = marked.parse(fullText);
                    break;
                  case 'error':
                    summariesDiv.innerHTML = `<p class="text-danger">Error: ${event.content}</p>`;
                    break;
                }
              } catch (e) {
                console.error('Error parsing stream event:', e, line);
              }
            });
            return pump();
          });
        }
      })
      .catch(err => {
        console.error('Error fetching summaries:', err);
        summariesDiv.innerHTML = '<p class="text-danger">Error occurred while generating summaries.</p>';
      });
  });
  //--------------------------------------------------------------------------
  // 4) GROK PROMPTS (now with raw toggle/copy per block)
  //--------------------------------------------------------------------------
  const runGrokBtn = document.getElementById('run-grok-btn');
  if (runGrokBtn) runGrokBtn.addEventListener('click', () => {
    const selectedPrompts = Array.from(document.querySelectorAll('#grok-prompts input:checked')).map(i => i.value);
    if (selectedPrompts.length === 0) return;
    const responsesDiv = document.getElementById('grok-responses');
    responsesDiv.innerHTML = '';
    fetch('/api/run-grok-prompts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompts: selectedPrompts })
    })
      .then(response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentPrompt = '';
        let currentResponse = '';
        let currentBlock = null;
        return pump();
        function pump () {
          return reader.read().then(({ done, value }) => {
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            lines.forEach(line => {
              if (!line.trim()) return;
              try {
                const event = JSON.parse(line);
                switch (event.type) {
                  case 'prompt':
                    currentPrompt = event.content;
                    currentResponse = '';
                    currentBlock = createMarkdownViewer('Prompt: ' + currentPrompt);
                    responsesDiv.appendChild(currentBlock.root);
                    break;
                  case 'chunk':
                    currentResponse += event.content;
                    if (currentBlock) currentBlock.setMarkdown(currentResponse);
                    break;
                  case 'end':
                    currentBlock = null;
                    break;
                  case 'error':
                    responsesDiv.appendChild(document.createTextNode(`Error: ${event.content}`));
                }
              } catch (e) { console.error('Error parsing event:', e); }
            });
            return pump();
          });
        }
      });
  });
  //--------------------------------------------------------------------------
  // 5) SAVE SETTINGS
  //--------------------------------------------------------------------------
  const saveSettingsBtn = document.getElementById('save-settings-btn');
  if (saveSettingsBtn) saveSettingsBtn.addEventListener('click', () => {
    const yaml = document.getElementById('settings-yaml').value;
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: yaml
    }).then(r => {
      if (r.ok) alert('Settings saved');
      else alert('Error saving settings');
    });
  });
  //--------------------------------------------------------------------------
  // 6) PPLX PROMPTS (dynamic with types)
  //--------------------------------------------------------------------------
  const runPplxBtn = document.getElementById('run-pplx-btn');
  if (runPplxBtn) runPplxBtn.addEventListener('click', () => {
    const queries = [];
    const checkboxes = document.querySelectorAll('#pplx-prompts input[type="checkbox"]:checked');
    checkboxes.forEach(cb => {
      const index = parseInt(cb.id.split('-')[2], 10);
      const query = pplxQueries[index];
      let q;
      if (query.type === 'fixed') {
        q = query.prompt;
      } else {
        const ta = document.getElementById('pplx-text-' + index);
        const input = ta.value.trim();
        if (!input) return;
        if (query.type === 'template') {
          q = query.prompt.replace(new RegExp(`{{${query.placeholder}}}`, 'g'), input);
        } else { // custom
          q = input;
        }
      }
      queries.push(q);
    });
    if (queries.length === 0) return;
    const responsesDiv = document.getElementById('pplx-responses');
    responsesDiv.innerHTML = '';
    fetch('/api/run-pplx-queries', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ queries })
    })
      .then(response => {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentBlock = null, currentQuery = '', currentResponse = '';
        return (function pump() {
          return reader.read().then(({ done, value }) => {
            if (done) return;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();
            for (let line of lines) {
              if (!line.trim()) continue;
              const event = JSON.parse(line);
               switch (event.type) {
                case 'query':
                  currentQuery = event.content;
                  currentResponse = '';
                  currentBlock = createMarkdownViewer('Query: ' + currentQuery);
                  responsesDiv.appendChild(currentBlock.root);
                  break;
                case 'chunk':
                  currentResponse += event.content;
                  if (currentBlock) currentBlock.setMarkdown(currentResponse);
                  break;
                case 'end':
                  currentBlock = null;
                  break;
              }
            }
            return pump();
          });
        })();
      })
      .catch(err => {
        console.error('Error fetching PPLX queries:', err);
        document.getElementById('pplx-responses').innerHTML =
          '<p class="text-danger">Error occurred while running PPLX queries.</p>';
      });
  });
  //--------------------------------------------------------------------------
  // Utility Buttons (copy / toggle)
  //--------------------------------------------------------------------------
  copyBtn.addEventListener('click', () => copyToClipboard(lastFullText));
  toggleBtn.addEventListener('click', () => {
    rawVisible = !rawVisible;
    if (rawVisible) {
      rawPre.textContent = lastFullText;
      rawPre.style.display = 'block';
      summariesDiv.style.display = 'none';
      toggleBtn.textContent = 'Toggle Formatted View';
    } else {
      rawPre.style.display = 'none';
      summariesDiv.style.display = 'block';
      toggleBtn.textContent = 'Toggle Raw / Formatted';
    }
  });
  function renderFormatted (markdown) {
    // Try the fancy structured view first -------------------------------
    summariesDiv.innerHTML = '';
    const sections = parseSummaries(markdown);
    if (sections.length > 0 && sections.some(s => s.items.length)) {
      sections.forEach(sec => {
        const h3 = document.createElement('h3');
        h3.textContent = sec.source;
        summariesDiv.appendChild(h3);
        const ul = document.createElement('ul');
        sec.items.forEach(item => {
          const li = document.createElement('li');
          li.innerHTML = item;
          ul.appendChild(li);
        });
        summariesDiv.appendChild(ul);
      });
    } else {
      // Fallback: plain markdown ----------------------------------------
      summariesDiv.innerHTML = marked.parse(markdown);
    }
    // Keep news spritz in sync if visible
    if (newsSpritzHost && newsSpritzHost.style.display !== 'none') {
      newsSpritz.setText(markdown || '');
    }
  }
  function revealUtilityButtons () {
    copyBtn.classList.remove('d-none');
    toggleBtn.classList.remove('d-none');
    const speedBtn = document.getElementById('speed-btn');
    if (speedBtn) speedBtn.classList.remove('d-none');
  }
  function hideUtilityButtons () {
    copyBtn.classList.add('d-none');
    toggleBtn.classList.add('d-none');
    const speedBtn = document.getElementById('speed-btn');
    if (speedBtn) speedBtn.classList.add('d-none');
  }
});
