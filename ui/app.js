'use strict';

const State = {
  mode: 'idle',
  project: null,
  files: [],
  selected: new Set(),
  lastPrompt: '',
  lastInstruction: '',
  recentProjects: [],
  isFirstTurn: true,
  autoCopy: true,
  expanded: new Set()
};

const $ = id => document.getElementById(id);
const py = {
  call: (m,...a) => window.pywebview.api[m](...a)
};

const Toast = {
  show(msg, ms=2000) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    setTimeout(() => t.classList.remove('show'), ms);
  }
};

const Chat = {
  feed: null,
  lastPromptRow: null,
  init() { this.feed = $('chatFeed'); },
  render(md) {
    if (!md) return '';
    try {
      if (window.marked) {
        const raw = marked.parse(md);
        return window.DOMPurify ? DOMPurify.sanitize(raw) : raw;
      }
    } catch(e) { /* fallback below */ }
    return this._inlineMarkdown(md);
  },

  _inlineMarkdown(md) {
    // Step 1: escape HTML entities but KEEP real newlines for regex processing
    let html = md
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Step 2: protect fenced code blocks first
    const saved = [];
    html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
      const i = saved.length;
      saved.push(`<pre><code class="language-${lang}">${code.trim()}</code></pre>`);
      return `\x00BLOCK${i}\x00`;
    });
    // protect inline code
    html = html.replace(/`([^`\n]+)`/g, (_, code) => {
      const i = saved.length;
      saved.push(`<code>${code}</code>`);
      return `\x00BLOCK${i}\x00`;
    });

    // Step 3: block-level elements (line-sensitive, must run before inline)
    html = html.replace(/^#{3} (.+)$/gm, '<h3>$1</h3>');
    html = html.replace(/^#{2} (.+)$/gm, '<h2>$1</h2>');
    html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
    html = html.replace(/^-{3,}$/gm, '<hr>');
    html = html.replace(/^&gt; (.+)$/gm, '<blockquote>$1</blockquote>');

    // Step 4: lists — process line-by-line for correct <ul>/<ol> wrapping
    const lines = html.split('\n');
    const out = [];
    let listStack = []; // stack of { type: 'ul'|'ol', indent: number }

    const closeListsTo = (targetIndent) => {
      while (listStack.length && listStack[listStack.length - 1].indent > targetIndent) {
        out.push(`</${listStack.pop().type}>`);
      }
    };

    for (const line of lines) {
      const ulM = line.match(/^(\s{0,8})[*\-] (.+)$/);
      const olM = line.match(/^(\s{0,8})\d+[.)]\s(.+)$/);
      const indent = ulM ? ulM[1].length : olM ? olM[1].length : 0;
      const type = ulM ? 'ul' : olM ? 'ol' : null;

      if (type) {
        closeListsTo(indent);
        const top = listStack[listStack.length - 1];
        if (!top || top.indent < indent) {
          out.push(`<${type}>`);
          listStack.push({ type, indent });
        } else if (top.type !== type) {
          out.push(`</${listStack.pop().type}>`);
          out.push(`<${type}>`);
          listStack.push({ type, indent });
        }
        out.push(`<li>${(ulM || olM)[2]}</li>`);
      } else {
        closeListsTo(-1);
        out.push(line);
      }
    }
    closeListsTo(-1);
    html = out.join('\n');

    // Step 5: inline formatting
    html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>');
    html = html.replace(/~~(.+?)~~/g, '<del>$1</del>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');

    // Step 6: wrap non-block text in <p>, split on blank lines
    const BLOCK_RE = /^<(h[1-6]|ul|ol|li|pre|blockquote|hr|div|\x00)/;
    const paras = html.split(/\n{2,}/);
    html = paras.map(block => {
      const t = block.trim();
      if (!t) return '';
      if (BLOCK_RE.test(t)) return t;
      return `<p>${t.replace(/\n/g, '<br>')}</p>`;
    }).filter(Boolean).join('\n');

    // Step 7: restore saved blocks
    saved.forEach((s, i) => { html = html.replace(`\x00BLOCK${i}\x00`, s); });

    return html;
  },
  addUser(text) {
    const row = document.createElement('div');
    row.className = 'msg user';
    const label = document.createElement('div');
    label.className = 'msg-label';
    label.textContent = 'You';
    const content = document.createElement('div');
    content.className = 'msg-content';
    const bubble = document.createElement('div');
    bubble.className = 'bubble';
    bubble.innerHTML = this.render(text);
    const btn = document.createElement('button');
    btn.className = 'msg-copy';
    btn.title = 'Copy message';
    btn.innerHTML = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    btn.onclick = () => App.copyToClipboard(text, 'Message copied');
    content.appendChild(btn);
    content.appendChild(bubble);
    row.appendChild(label);
    row.appendChild(content);
    this.feed.appendChild(row);
    this.scroll();
  },
  addTinc(html) {
    const row = document.createElement('div');
    row.className = 'msg tinc';
    row.innerHTML = `<div class="msg-label">TINC</div><div class="bubble">${html}</div>`;
    this.feed.appendChild(row);
    this.scroll();
  },
  addPrompt(prompt, tokens, files) {
    const preview = prompt.slice(0, 300).replace(/</g,'&lt;');
    const row = document.createElement('div');
    row.className = 'msg tinc';
    row.innerHTML = `<div class="msg-label">TINC</div><div class="bubble">
      <div style="margin-bottom:10px;font-size:13px;color:var(--muted)">Prompt generated · ~${tokens} tokens · ${files} files</div>
      <div class="prompt-preview" style="padding:8px;border-radius:4px;font-family:monospace;font-size:11px;max-height:100px;overflow:hidden;margin-bottom:10px">${preview}...</div>
      <button onclick="App.copyPrompt()" style="padding:6px 12px;background:var(--accent);color:#fff;border:none;border-radius:4px;font-weight:600;font-size:12px;cursor:pointer">Copy prompt</button>
      <span style="margin-left:8px;font-size:12px;color:var(--muted)">→ Paste in AI chat</span>
    </div>`;
    this.feed.appendChild(row);
    this.lastPromptRow = row;
    this.scroll();
  },
  addWaitingBubble() {
    const row = document.createElement('div');
    row.className = 'msg tinc';
    row.innerHTML = `<div class="msg-label">TINC</div><div class="bubble" style="color:var(--muted)">
      Waiting for AI response... Paste the response here when ready.
    </div>`;
    this.feed.appendChild(row);
    this.lastPromptRow = row;
    this.scroll();
  },
  replacePromptWithResults(html) {
    if (this.lastPromptRow) {
      this.lastPromptRow.innerHTML = `<div class="msg-label">TINC</div><div class="bubble">${html}</div>`;
      this.lastPromptRow = null;
      this.scroll();
    } else {
      this.addTinc(html);
    }
  },
  escape(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>'); },
  scroll() { setTimeout(() => this.feed.scrollTop = this.feed.scrollHeight, 50); },
  clear() { this.feed.innerHTML = ''; this.lastPromptRow = null; }
};

const App = {
  async openProject() {
    $('projectsDropdown').classList.add('hidden');
    const res = await py.call('open_folder_dialog');
    if (res.cancelled || res.error) return;
    State.project = res;
    $('projectName').textContent = res.name;
    document.querySelector('.dot').classList.add('active');
    State.selected = new Set(res.files.map(f => f.path));
    this.renderFiles(res.files);
    $('mainInput').disabled = false;
    $('btnSend').disabled = false;
    Chat.clear();
    State.isFirstTurn = true;
    this.setMode('instruction');
  },

  async toggleProjects() {
    const dd = $('projectsDropdown');
    const isHidden = dd.classList.contains('hidden');
    if (isHidden) {
      await this.loadRecentProjects();
      dd.classList.remove('hidden');
    } else {
      dd.classList.add('hidden');
    }
  },

  toggleSettings() {
    const modal = $('settingsModal');
    modal.classList.toggle('hidden');
    // Sync switch state when opening settings
    if (!modal.classList.contains('hidden')) {
      const isLight = document.documentElement.getAttribute('data-theme') === 'light';
      $('themeSwitch').checked = isLight;
      $('autoCopySwitch').checked = State.autoCopy;
    }
  },

  initTheme() {
    const saved = localStorage.getItem('tinc-theme');
    const theme = saved || 'dark';
    document.documentElement.setAttribute('data-theme', theme);
    if ($('themeSwitch')) {
      $('themeSwitch').checked = theme === 'light';
    }
  },

  initSettings() {
    const savedAutoCopy = localStorage.getItem('tinc-autocopy');
    State.autoCopy = savedAutoCopy !== 'false';
    if ($('autoCopySwitch')) {
      $('autoCopySwitch').checked = State.autoCopy;
    }
  },

  toggleAutoCopy() {
    State.autoCopy = $('autoCopySwitch').checked;
    localStorage.setItem('tinc-autocopy', State.autoCopy);
    Toast.show(`Auto-copy ${State.autoCopy ? 'enabled' : 'disabled'}`);
  },

  toggleTheme() {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const newTheme = isLight ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', newTheme);
    localStorage.setItem('tinc-theme', newTheme);
    Toast.show(`${newTheme === 'light' ? 'Light' : 'Dark'} mode`);
  },

  async loadRecentProjects() {
    const recents = await py.call('get_recent_projects');
    State.recentProjects = recents;
    this.renderRecentProjects();
  },

  renderRecentProjects() {
    const list = $('recentList');
    const recents = State.recentProjects || [];
    if (recents.length === 0) {
      list.innerHTML = '<div class="recent-empty">No recent projects</div>';
      return;
    }
    list.innerHTML = '';
    recents.forEach(r => {
      const item = document.createElement('div');
      item.className = 'recent-item';
      item.innerHTML = `<div class="recent-name">${r.name}</div><div class="recent-path" title="${r.path}">${r.path}</div>`;
      item.onclick = () => this.openRecentProject(r.path);
      list.appendChild(item);
    });
  },

  async openRecentProject(path) {
    $('projectsDropdown').classList.add('hidden');
    const res = await py.call('load_project', path);
    if (res.success) {
      State.project = res;
      $('projectName').textContent = res.name;
      document.querySelector('.dot').classList.add('active');
      State.selected = new Set(res.files.map(f => f.path));
      this.renderFiles(res.files);
      $('mainInput').disabled = false;
      $('btnSend').disabled = false;
      Chat.clear();
      State.isFirstTurn = true;
      this.setMode('instruction');
      Toast.show(`Opened ${res.name}`);
    }
  },

  renderFiles(files) {
    State.files = files;
    if (!State.expanded) State.expanded = new Set();
    
    // Build tree from flat file list
    const tree = { name: '', path: '', type: 'folder', children: [] };
    files.forEach(f => {
      const parts = f.path.split('/');
      let node = tree;
      parts.forEach((part, i) => {
        const isFile = i === parts.length - 1;
        const currentPath = parts.slice(0, i + 1).join('/');
        let child = node.children.find(c => c.name === part);
        if (!child) {
          child = { name: part, path: currentPath, type: isFile ? 'file' : 'folder', children: [] };
          node.children.push(child);
        }
        node = child;
      });
    });

    const list = $('fileList');
    list.innerHTML = '';
    
    const getDescendantFiles = (node) => {
      if (node.type === 'file') return [node.path];
      return node.children.flatMap(getDescendantFiles);
    };

    const renderNode = (node, depth = 0) => {
      if (node.type === 'folder' && node.name === '') {
        node.children.sort((a, b) => {
          if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        node.children.forEach(child => renderNode(child, depth));
        return;
      }

      const item = document.createElement('div');
      item.className = 'file-item';
      item.style.paddingLeft = `${8 + depth * 16}px`;
      
      const isFolder = node.type === 'folder';
      const descendants = isFolder ? getDescendantFiles(node) : [];
      const allSelected = isFolder ? descendants.every(p => State.selected.has(p)) : State.selected.has(node.path);
      const someSelected = isFolder ? descendants.some(p => State.selected.has(p)) : false;
      
      if (allSelected) item.classList.add('checked');
      else if (someSelected) item.classList.add('partial');

      const arrow = isFolder ? 
        `<svg class="tree-arrow" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M9 18l6-6-6-6"/></svg>` : 
        `<span style="width:12px;display:inline-block"></span>`;
      
      const icon = isFolder ? 
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.7;flex-shrink:0"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>` : 
        `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="opacity:0.5;flex-shrink:0"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`;

      item.innerHTML = `${arrow}<div class="file-check"></div>`;
      const checkDiv = item.querySelector('.file-check');
      checkDiv.insertAdjacentHTML('afterend', icon + `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0">${node.name}</span>`);
      
      // Separate handler for arrow (expand/collapse only)
      const arrowEl = item.querySelector('.tree-arrow');
      if (arrowEl && isFolder) {
        arrowEl.onclick = (e) => {
          e.stopPropagation();
          const isExpanded = State.expanded.has(node.path);
          if (isExpanded) State.expanded.delete(node.path);
          else State.expanded.add(node.path);
          this.renderFiles(State.files);
        };
      }
      
      item.onclick = (e) => {
        e.stopPropagation();
        if (isFolder) {
          const allSel = descendants.every(p => State.selected.has(p));
          descendants.forEach(p => {
            if (allSel) State.selected.delete(p);
            else State.selected.add(p);
          });
          this.renderFiles(State.files);
        } else {
          if (State.selected.has(node.path)) {
            State.selected.delete(node.path);
          } else {
            State.selected.add(node.path);
          }
          this.renderFiles(State.files);
        }
      };

      list.appendChild(item);
      
      if (isFolder) {
        const isExpanded = State.expanded.has(node.path);
        const arrowEl = item.querySelector('.tree-arrow');
        if (arrowEl) arrowEl.style.transform = isExpanded ? 'rotate(90deg)' : 'rotate(0deg)';
        
        if (isExpanded) {
          node.children.sort((a, b) => {
            if (a.type !== b.type) return a.type === 'folder' ? -1 : 1;
            return a.name.localeCompare(b.name);
          });
          node.children.forEach(child => renderNode(child, depth + 1));
        }
      }
    };

    renderNode(tree);
  },

  selectAll() {
    State.selected = new Set(State.files.map(f => f.path));
    this.renderFiles(State.files);
    Toast.show('All selected');
  },

  selectNone() {
    State.selected.clear();
    this.renderFiles(State.files);
    Toast.show('None selected');
  },

  setMode(mode) {
    State.mode = mode;
    const label = $('modeLabel');
    const input = $('mainInput');
    const wrap = $('inputWrap');
    if (mode === 'instruction') {
      label.textContent = '✦ Instruction for the AI';
      label.className = 'mode-label';
      input.placeholder = 'Describe what you want to do...';
      if (wrap) wrap.classList.remove('response-mode');
    } else {
      label.textContent = '⬡ AI Response';
      label.className = 'mode-label response';
      input.placeholder = 'Paste the complete AI response here...';
      if (wrap) wrap.classList.add('response-mode');
    }
    input.value = '';
    input.focus();
  },

  async handleSend() {
    const text = $('mainInput').value.trim();
    if (!text) return;

    if (State.mode === 'instruction') {
      Chat.addUser(text);
      State.lastInstruction = text;
      this.setMode('waiting');
      const res = await py.call('build_context_prompt', text, [...State.selected]);
      State.lastPrompt = res.prompt;
      if (State.isFirstTurn) {
        Chat.addPrompt(res.prompt, res.token_str, res.files_count);
        State.isFirstTurn = false;
        if (State.autoCopy) {
          this.copyToClipboard(res.prompt, 'Prompt copied');
        }
      } else {
        Chat.addWaitingBubble();
        if (State.autoCopy) {
          this.copyToClipboard(text, 'Message copied');
        }
      }
      this.setMode('response');
    } else {
      const res = await py.call('parse_ai_response', text);
      if (res.count > 0) {
        // Dry-run: check for conflicts before applying anything
        const check = await py.call('check_pending_changes');
        if (check.conflicts && check.conflicts.length > 0) {
          const resolved = await ConflictResolver.resolve(check.conflicts);
          if (!resolved) {
            this.setMode('instruction');
            return;
          }
        }

        const apply = await py.call('apply_all_pending', State.lastInstruction);
        if (apply.files) {
          State.selected = new Set(apply.files.map(f => f.path));
          this.renderFiles(apply.files);
        }
        
        // Map backend execution results back to the local copy of changes
        res.changes.forEach(c => {
          const result = apply.results.find(r => r.id === c.id);
          if (result) {
            c.status = result.success ? 'applied' : 'error';
            c.error = result.error;
          }
        });

        const ok = apply.results.filter(r => r.success).length;
        let html = '';
        if (res.plan) {
          html += `<div class="plan-box"><div class="plan-title"><svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" style="vertical-align: middle; margin-right: 6px; position: relative; top: -1px;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>Plan</div>${Chat.render(res.plan)}</div>`;
        }
        html += `<div style="font-size:13px;margin-bottom:8px">${ok} changes applied</div>`;
        res.changes.forEach(c => {
          const applied = c.status === 'applied';
          const icon = applied ? '✓' : '✗';
          const color = applied ? 'var(--green)' : 'var(--red)';
          const errBox = !applied && c.error
            ? `<div style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.3);border-radius:4px;padding:6px 8px;margin-top:6px;font-size:11px;color:var(--red)">${Chat.escape(c.error)}</div>`
            : '';
          html += `<div style="font-family:monospace;font-size:12px;padding:8px 0;border-bottom:1px solid var(--border)"><span style="color:${color}">${icon}</span> ${c.action} <span style="color:var(--text);opacity:0.8">${c.path}</span>${errBox}</div>`;
        });
        if (res.summary) {
          html += `<div class="summary-box"><div class="summary-title"><svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" style="vertical-align: middle; margin-right: 6px; position: relative; top: -1px;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>Summary</div>${Chat.render(res.summary)}</div>`;
        }
        Chat.replacePromptWithResults(html);
        Toast.show(`Applied ${ok} changes`);
      } else {
        let html = '';
        if (res.plan) {
          html += `<div class="plan-box"><div class="plan-title"><svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" style="vertical-align: middle; margin-right: 6px; position: relative; top: -1px;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-3 7h3m-3 4h3m-6-4h.01M9 16h.01"/></svg>Plan</div>${Chat.render(res.plan)}</div>`;
        }
        if (res.summary) {
          html += `<div class="summary-box"><div class="summary-title"><svg width="13" height="13" viewBox="0 0 24 24" stroke="currentColor" stroke-width="2.5" fill="none" style="vertical-align: middle; margin-right: 6px; position: relative; top: -1px;"><path stroke-linecap="round" stroke-linejoin="round" d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>Summary</div>${Chat.render(res.summary)}</div>`;
        }
        if (!html) {
          html = 'No changes detected in response';
        }
        Chat.replacePromptWithResults(html);
      }
      this.setMode('instruction');
    }
  },

  copyPrompt() {
  const text = State.lastPrompt;
  
  // Intento 1: API moderna, solo funciona en HTTPS/localhost
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      Toast.show('Prompt copied');
    }).catch(() => {
      this.copyFallback(text); // Si falla por permisos, usa fallback
    });
  } else {
    // Intento 2: Fallback para file://
    this.copyFallback(text);
  }
},

copyFallback(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy'); // Deprecated pero funciona en file://
    Toast.show('Prompt copied');
  } catch (err) {
    Toast.show('Error: Select text manually');
  }
  document.body.removeChild(ta);
},

async copyContext() {
  if (!State.project) {
    Toast.show('No project open');
    return;
  }
  if (State.selected.size === 0) {
    Toast.show('No files selected');
    return;
  }
  const res = await py.call('get_context_for_copy', [...State.selected]);
  if (res.error) {
    Toast.show('Error: ' + res.error);
    return;
  }
  const text = res.context || '';
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      Toast.show('Contexto copiado');
    }).catch(() => {
      this.copyFallbackContext(text);
    });
  } else {
    this.copyFallbackContext(text);
  }
},

copyFallbackContext(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    Toast.show('Contexto copiado');
  } catch (err) {
    Toast.show('Error al copiar');
  }
  document.body.removeChild(ta);
},

copyToClipboard(text, toastMsg) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => {
      if (toastMsg) Toast.show(toastMsg);
    }).catch(() => {
      this.copyToClipboardFallback(text, toastMsg);
    });
  } else {
    this.copyToClipboardFallback(text, toastMsg);
  }
},

copyToClipboardFallback(text, toastMsg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    if (toastMsg) Toast.show(toastMsg);
  } catch (err) {
    if (toastMsg) Toast.show('Error: Select text manually');
  }
  document.body.removeChild(ta);
},

async openFolder() {
  if (!State.project) {
    Toast.show('No project open');
    return;
  }
  const res = await py.call('open_containing_folder');
  if (res.success) {
    Toast.show('Open folder');
  } else {
    Toast.show('Error: ' + (res.error || 'It could not be opened'));
  }
},

  clearChat() {
    $('confirmModal').classList.remove('hidden');
  },

  closeConfirm(confirmed) {
    $('confirmModal').classList.add('hidden');
    if (confirmed) {
      Chat.clear();
      State.isFirstTurn = true;
      this.setMode('instruction');
    }
  },

  async showHistory() {
    if (!State.project) return;
    const hist = await py.call('get_session_history');
    const list = $('historyList');
    list.innerHTML = hist.length? '' : '<div style="padding:20px;text-align:center;color:#666">There is no history</div>';
    hist.forEach(h => {
      const item = document.createElement('div');
      item.className = 'history-item-new';
      const promptText = h.prompt || 'No prompt';
      const prompt = promptText.length > 80? promptText.substring(0, 77) + '...' : promptText;
      item.innerHTML = `
        <div class="history-content">
          <div class="history-prompt" title="${promptText.replace(/"/g, '&quot;')}">${prompt}</div>
          <div class="history-meta">${h.time} · ${h.changes} changes</div>
        </div>
        <button class="btn-undo" onclick="App.confirmUndo('${h.snapshot}', '${encodeURIComponent(prompt)}')">Undo</button>
      `;
      list.appendChild(item);
    });
    $('historyModal').classList.remove('hidden');
  },

  confirmUndo(snapshot, prompt) {
    prompt = decodeURIComponent(prompt);
    State.pendingUndo = { snapshot, prompt };
    $('undoPromptText').textContent = '"' + prompt + '"';
    $('historyModal').classList.add('hidden');
    $('undoModal').classList.remove('hidden');
  },

  async closeUndoConfirm(confirmed) {
    $('undoModal').classList.add('hidden');
    if (!confirmed || !State.pendingUndo) {
      State.pendingUndo = null;
      $('historyModal').classList.remove('hidden');
      return;
    }

    const { snapshot, prompt } = State.pendingUndo;
    State.pendingUndo = null;

    $('historyModal').classList.add('hidden');
    Toast.show('Undoing...');

    const res = await py.call('undo_to_snapshot', snapshot);
    if (res.success) {
      Toast.show('Changes discarded');
      // Refresh file tree
      const project = await py.call('load_project', State.project.path);
      State.project = project;
      this.renderFiles(project.files);
      Chat.addTinc(`<div style="color:var(--green)">✓ Reverted to: ${prompt}</div>`);
    } else {
      Toast.show('Error: ' + (res.error || 'It could not be undone'));
    }
  }
};

const ConflictResolver = {
  _conflicts: [],
  _current: 0,
  _resolve: null,
  _selected: null,

  resolve(conflicts) {
    return new Promise((res) => {
      // Si algún conflicto no tiene candidatos, cancelar todo inmediatamente
      const noMatch = conflicts.find(c => !c.suggestions || c.suggestions.length === 0);
      if (noMatch) {
        Chat.replacePromptWithResults(
          `<div style="color:var(--red);padding:8px 0">✗ No candidates were found for <code>${noMatch.path}</code>.<br><span style="color:#888;font-size:12px">No changes were applied. Please verify that the AI ​​response is correct for this project.</span></div>`
        );
        res(false);
        return;
      }
      this._conflicts = conflicts;
      this._current = 0;
      this._resolve = res;
      this._selected = null;
      this._render();
      $('conflictModal').classList.remove('hidden');
    });
  },

  _render() {
    const conflict = this._conflicts[this._current];
    const total = this._conflicts.length;
    $('conflictCounter').textContent = `Conflict ${this._current + 1} of ${total}`;
    $('conflictFile').textContent = conflict.path;
    $('conflictSearchText').textContent = conflict.search_text || '';
    $('btnUseCandidate').disabled = true;
    this._selected = null;

    const list = $('conflictCandidates');
    list.innerHTML = '';
    conflict.suggestions.forEach((s, i) => {
      const card = document.createElement('div');
      card.className = 'candidate-card';
      // highlight >>> lines in preview
      const previewHtml = Chat.escape(s.preview).replace(/^(&gt;&gt;&gt; .*)/gm,
        '<span class="candidate-highlight">$1</span>');
      // diff visual en verde
      const matched = s.matched_text || '';
      const replace = conflict.replace_text || '';
      const mLines = new Set(matched.split('\n').map(l => l.trim()));
      const diffHtml = replace.split('\n').map(l => {
        const esc = Chat.escape(l);
        const isNew = l.trim() && !mLines.has(l.trim());
        return isNew ? `<span style="color:#22c55e;background:rgba(34,197,94,0.15)">${esc}</span>` : esc;
      }).join('\n');
      card.innerHTML = `
        <div class="candidate-meta">
          <span class="candidate-score">${Math.round(s.score * 100)}% match</span>
          <span class="candidate-line">~line ${s.line}</span>
        </div>
        <pre class="candidate-preview">${previewHtml}</pre>
        <div style="margin-top:8px;padding-top:8px;border-top:1px solid #222">
          <div style="font-size:10px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:0.03em">It will be replaced with:</div>
          <pre style="font-family:var(--mono);font-size:11px;background:rgba(34,197,94,0.06);border:1px solid rgba(34,197,94,0.2);border-radius:4px;padding:6px;margin:0;white-space:pre-wrap;line-height:1.4">${diffHtml}</pre>
        </div>`;
      card.onclick = () => {
        list.querySelectorAll('.candidate-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        this._selected = s.matched_text;
        $('btnUseCandidate').disabled = false;
      };
      list.appendChild(card);
    });
  },

  async applySelected() {
    if (!this._selected) return;
    const conflict = this._conflicts[this._current];
    await py.call('resolve_conflict', conflict.id, this._selected);
    this._current++;
    if (this._current >= this._conflicts.length) {
      $('conflictModal').classList.add('hidden');
      this._resolve(true);
    } else {
      this._render();
    }
  },

  cancelAll() {
    $('conflictModal').classList.add('hidden');
    this._resolve(false);
  }
};

document.addEventListener('DOMContentLoaded', () => {
  Chat.init();
  App.initTheme();
  App.initSettings();
  
  window.addEventListener('pywebviewready', () => {
    App.toggleProjects();
  });

  const input = $('mainInput');
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter' &&!e.shiftKey) {
      e.preventDefault();
      App.handleSend();
    }
  });
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 120) + 'px';
  });
});
