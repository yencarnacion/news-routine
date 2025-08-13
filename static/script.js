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
// ----------------------------------------------------------------------------
// DOMContentLoaded
// ----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  // HTTP HTTP elements
  const summariesDiv = document.getElementById('summaries');
  const rawPre = document.getElementById('raw-markdown');
  const copyBtn = document.getElementById('copy-btn');
  const toggleBtn = document.getElementById('toggle-btn');
  let lastFullText = '';
  let rawVisible = false;
  let pplxQueries = []; // Store for run logic
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
  // 4) GROK PROMPTS (unchanged logic)
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
        let currentDiv = null;
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
                    if (currentDiv) {
                      currentDiv.innerHTML = `<h3>Prompt: ${currentPrompt}</h3>` + marked.parse(currentResponse);
                    }
                    currentPrompt = event.content;
                    currentResponse = '';
                    currentDiv = document.createElement('div');
                    responsesDiv.appendChild(currentDiv);
                    break;
                  case 'chunk':
                    currentResponse += event.content;
                    currentDiv.innerHTML = `<h3>Prompt: ${currentPrompt}</h3>` + marked.parse(currentResponse);
                    break;
                  case 'end':
                    currentDiv.innerHTML = `<h3>Prompt: ${currentPrompt}</h3>` + marked.parse(currentResponse);
                    currentDiv = null;
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
        let currentDiv = null, currentQuery = '', currentResponse = '';
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
                  if (currentDiv) currentDiv.innerHTML = `<h3>Query: ${currentQuery}</h3>` + marked.parse(currentResponse);
                  currentQuery = event.content;
                  currentResponse = '';
                  currentDiv = document.createElement('div');
                  responsesDiv.appendChild(currentDiv);
                  break;
                case 'chunk':
                  currentResponse += event.content;
                  currentDiv.innerHTML = `<h3>Query: ${currentQuery}</h3>` + marked.parse(currentResponse);
                  break;
                case 'end':
                  currentDiv = null;
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
  }
  function revealUtilityButtons () {
    copyBtn.classList.remove('d-none');
    toggleBtn.classList.remove('d-none');
  }
  function hideUtilityButtons () {
    copyBtn.classList.add('d-none');
    toggleBtn.classList.add('d-none');
  }
});
