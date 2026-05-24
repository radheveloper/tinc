import os
import re
import json
import sqlite3
import subprocess
import fnmatch
from pathlib import Path
from datetime import datetime
import tiktoken

DEFAULT_IGNORE = [
    '.git', '__pycache__', '*.pyc', 'node_modules', '.env', '*.log',
    '*.jpg', '*.png', '*.gif', '*.pdf', '*.zip', 'dist', 'build',
    'venv', '.venv', '.DS_Store', 'package-lock.json', 'yarn.lock',
    '.tinc', '.tincignore',
]

SYSTEM_PROMPT = """You are TINC, an expert, creative AI coding agent designed for "vibecoding". 

Your goal is to bring the user's high-level ideas to life. You architect and implement complete, working solutions, handling logic, styling, and wiring seamlessly. Never leave placeholders like `// TODO: implement` or `/* rest of the code */`. Write the actual, fully functional code.

## CRITICAL CONSTRAINT: SURGICAL EDITS
Even though you are building complete features, you must be extremely efficient with your output. **NEVER rewrite entire existing files** unless strictly necessary. 
If a feature requires changing 3 different functions or sections in a file, use 3 separate `REPLACE_IN_FILE` blocks. Keep your responses short and focused only on what changes.

## STEP 1 — THE VIBE PLAN (Re-Reading Strategy)
Before writing code, you MUST output a <tinc-plan> block. This is crucial for complex project contexts.

Structure your plan as follows:
1. **User Request Interpretation:** Briefly restate the user's specific goal in your own words to confirm understanding. This acts as a "re-reading" mechanism to ground your logic.
2. **Strategy:** Outline the architectural changes or logic flow.
3. **Impact Analysis:** List files that need modification.

## STEP 2 — CHANGE BLOCKS
Use these EXACT XML formats. Do NOT wrap blocks in markdown fences (```).

### 1. Edit an existing file (SURGICAL)
<tinc-change>
<action>REPLACE_IN_FILE</action>
<path>relative/path/to/file.ext</path>
<search>
[Copy the lines to replace VERBATIM. Include enough surrounding lines (minimum 5-10) to ensure the block is unique in the file. NEVER truncate or skip lines.]
</search>
<replace>
[The new, fully implemented code block that replaces the search block]
</replace>
</tinc-change>

### 2. Create a new file (or >80% rewrite)
<tinc-change>
<action>CREATE_FILE</action>
<path>relative/path/to/new_file.ext</path>
<content>
[COMPLETE AND FULLY FUNCTIONAL FILE CONTENT]
</content>
</tinc-change>

### 3. Delete a file
<tinc-change>
<action>DELETE_FILE</action>
<path>relative/path/to/old_file.ext</path>
</tinc-change>

## STEP 3 — SUMMARY
After all changes, provide a brief summary and further suggestions inside a <tinc-summary> tag using Markdown.

## RULES
1. One logical change per <tinc-change> block.
2. <search> blocks MUST perfectly match the existing local file. Do not invent context please, is super IMPORTANT.
3. Be bold and creative with the solution, but surgical with the file edits.
4. Do NOT include the context wrapper tags (<file path="..."> or </file>) inside your blocks.
5. Always match the user's language in your response (plan and summary).

## HANDLING QUESTIONS
If the user's message is a question, explanation request, or discussion — NOT a code change request — respond ONLY with a <tinc-plan> block containing your full Markdown answer. Do NOT emit any <tinc-change> blocks in this case.
"""

FORMAT_REMINDER = """
---
## FINAL OUTPUT CHECKLIST (READ THIS BEFORE GENERATING)
1. Output <tinc-plan> first if this is a change request.
2. Then output <tinc-change> blocks.
3. **DO NOT** use Markdown fences (```) around XML blocks.
4. Ensure every <search> block is a VERBATIM copy from the files above.
5. Ensure all XML tags are closed properly.
6. Close correctly even the <tinc-summary> block using </tinc-summary>

Example of a correct block:
<tinc-change>
<action>REPLACE_IN_FILE</action>
<path>relative/path/to/file.css</path>
<search>
body {
  margin: 0;
  background: #000;
}
</search>
<replace>
body {
  margin: 0;
  background: #fff;
}
</replace>
</tinc-change>
"""

class TINCBackend:
    def __init__(self):
        self.project_path = None
        self.pending_changes = []
        self.db_path = None
        self.ignore_patterns = DEFAULT_IGNORE[:]

    # ─── Project ───
    def open_folder_dialog(self):
        import webview
        result = webview.windows[0].create_file_dialog(webview.FOLDER_DIALOG)
        if result:
            return self.load_project(result[0])
        return {'cancelled': True}

    def load_project(self, path: str):
        p = Path(path).resolve()
        if not p.is_dir():
            return {'error': 'Folder not found'}

        self.project_path = p
        self.pending_changes = []
        self._init_git()
        self._load_tincignore()
        self._init_db()
        self._save_recent_project(str(p))

        return {
            'success': True,
            'name': p.name,
            'path': str(p),
            'files': self.get_file_tree()
        }

    def _init_git(self):
        if not (self.project_path / '.git').exists():
            self._run_git(['init'])
        self._run_git(['config', 'user.name', 'TINC'])
        self._run_git(['config', 'user.email', 'tinc@local'])
        if self._run_git(['rev-parse', 'HEAD']).returncode!= 0:
            self._run_git(['add', '-A'])
            self._run_git(['commit', '-m', 'tinc: init', '--allow-empty'])

    def _run_git(self, args):
        return subprocess.run(['git'] + args, cwd=str(self.project_path),
                            capture_output=True, text=True)

    def _git_snapshot(self):
        self._run_git(['add', '-A'])
        self._run_git(['commit', '-m', 'tinc: snapshot', '--allow-empty'])
        return self._run_git(['rev-parse', 'HEAD']).stdout.strip()

    # ─── Files ───
    def _load_tincignore(self):
        ti = self.project_path / '.tincignore'
        if ti.exists():
            custom = [l.strip() for l in ti.read_text().splitlines() if l.strip() and not l.startswith('#')]
            self.ignore_patterns = DEFAULT_IGNORE + custom
        else:
            ti.write_text("# TINC ignore\n" + "\n".join(DEFAULT_IGNORE))

    def _should_ignore(self, path: str):
        p = Path(path)
        for pat in self.ignore_patterns:
            if fnmatch.fnmatch(str(p), pat) or fnmatch.fnmatch(p.name, pat):
                return True
        return False

    def get_file_tree(self):
        files = []
        for root, dirs, names in os.walk(self.project_path):
            rel_root = Path(root).relative_to(self.project_path)
            dirs[:] = [d for d in dirs if not self._should_ignore(str(rel_root / d))]
            for n in sorted(names):
                rel = str(rel_root / n).replace('\\', '/')
                if not self._should_ignore(rel):
                    try:
                        size = (self.project_path / rel).stat().st_size
                        files.append({'path': rel, 'size': size})
                    except: pass
        return files

    def read_file_content(self, rel_path):
        try:
            return (self.project_path / rel_path).read_text(encoding='utf-8', errors='replace')
        except:
            return None

    def get_context_for_copy(self, selected_files=None):
        if not self.project_path:
            return {'error': 'No project'}
        
        files = self.get_file_tree()
        if selected_files:
            files = [f for f in files if f['path'] in selected_files]
        
        parts = []
        for f in files:
            content = self.read_file_content(f['path'])
            if content is not None:
                parts.append(f"{f['path']}:\n```\n{content}\n```")
        
        return {'context': '\n\n'.join(parts)}

    def open_containing_folder(self):
        if not self.project_path:
            return {'error': 'No project'}
        import platform
        path = str(self.project_path)
        try:
            if platform.system() == 'Windows':
                os.startfile(path)
            elif platform.system() == 'Darwin':
                subprocess.run(['open', path])
            else:
                subprocess.run(['xdg-open', path])
            return {'success': True}
        except Exception as e:
            return {'error': str(e)}

    # ─── Prompt ───
    def build_context_prompt(self, instruction: str, selected_files=None):
        if not self.project_path:
            return {'error': 'No project'}

        files = self.get_file_tree()
        if selected_files:
            files = [f for f in files if f['path'] in selected_files]

        parts = []
        for f in files:
            content = self.read_file_content(f['path'])
            if content:
                parts.append(f'<file path="{f["path"]}">\n{content}\n</file>')

        prompt = SYSTEM_PROMPT + '\n\n## PROJECT FILES\n\n' + '\n\n'.join(parts)
        prompt += '\n\n## TASK\n\n' + instruction.strip() + '\n\n' + FORMAT_REMINDER

        try:
            encoding = tiktoken.get_encoding("cl100k_base")
            tokens_count = len(encoding.encode(prompt))
            token_str = f"{tokens_count:,}"
        except Exception:
            token_str = f"{len(prompt.split()):,}"

        return {
            'prompt': prompt,
            'token_str': token_str,
            'files_count': len(parts)
        }

    # ─── Parse ───
    def parse_ai_response(self, response: str):
        plan = re.search(r'<tinc-plan>(.*?)</tinc-plan>', response, re.S | re.I)
        plan_text = plan.group(1).strip() if plan else ''

        summary = re.search(r'<tinc-summary>(.*?)</tinc-summary>', response, re.S | re.I)
        summary_text = summary.group(1).strip() if summary else ''

        changes = []
        for i, m in enumerate(re.finditer(r'<tinc-change>(.*?)</tinc-change>', response, re.S | re.I)):
            block = m.group(1)
            action = self._tag(block, 'action')
            path = self._tag(block, 'path')
            if not action or not path:
                continue

            ch = {'id': i, 'action': action.upper(), 'path': path.replace('\\', '/'), 'status': 'pending'}

            if action.upper() == 'CREATE_FILE':
                ch['content'] = self._tag(block, 'content') or ''
            elif action.upper() == 'REPLACE_IN_FILE':
                ch['search_text'] = self._tag(block, 'search') or ''
                ch['replace_text'] = self._tag(block, 'replace') or ''

            changes.append(ch)

        self.pending_changes = changes
        return {'plan': plan_text, 'summary': summary_text, 'changes': changes, 'count': len(changes)}

    def _tag(self, text, tag):
        m = re.search(rf'<{tag}>(.*?)</{tag}>', text, re.S | re.I)
        return m.group(1).strip('\n') if m else ''

    def _find_match(self, file_content: str, search_text: str) -> dict:
        """Encuentra search_text en file_content usando 7 estrategias progresivas."""
        if not search_text:
            return {'found': False}

        # 1. Exact match
        idx = file_content.find(search_text)
        if idx!= -1:
            return {'found': True, 'method': 'exact', 'index': idx}

        # 2. Normalizar saltos de línea
        norm_content = file_content.replace('\r\n', '\n').replace('\r', '\n')
        norm_search = search_text.replace('\r\n', '\n').replace('\r', '\n')
        idx = norm_content.find(norm_search)
        if idx!= -1:
            return {'found': True, 'method': 'normalized', 'index': idx, 'norm_content': norm_content, 'norm_search': norm_search}

        # 3. Strip trailing whitespace
        def strip_trailing(t): return '\n'.join(l.rstrip() for l in t.split('\n'))
        stripped_content = strip_trailing(norm_content)
        stripped_search = strip_trailing(norm_search)
        idx = stripped_content.find(stripped_search)
        if idx!= -1:
            return {'found': True, 'method': 'stripped', 'index': idx}

        # 4. Collapse whitespace interno
        def collapse(t): return '\n'.join(re.sub(r'[ \t]+', ' ', l) for l in t.split('\n'))
        collapsed_content = collapse(stripped_content)
        collapsed_search = collapse(stripped_search)
        idx = collapsed_content.find(collapsed_search)
        if idx!= -1:
            return {'found': True, 'method': 'collapsed', 'index': idx}

        # 5. Line-by-line fuzzy (ignora líneas vacías)
        file_lines = [l.rstrip() for l in norm_content.split('\n')]
        search_lines = [l.rstrip() for l in norm_search.split('\n') if l.strip()]
        if search_lines:
            for i in range(len(file_lines) - len(search_lines) + 1):
                match = True
                for j, sl in enumerate(search_lines):
                    if file_lines[i+j].strip() != sl.strip():
                        if file_lines[i+j].strip() != '':
                            match = False
                            break
                if match:
                    end = i + len(search_lines)
                    while end < len(file_lines) and end - i < len(search_lines) + 2 and file_lines[end].strip() == '':
                        end += 1
                    matched = '\n'.join(file_lines[i:end])
                    return {'found': True, 'method': 'fuzzy_lines', 'exact_text': matched}

        # 6. Dense matching (sin whitespace)
        def dense(t): return ''.join(t.split())
        dense_content = dense(norm_content)
        dense_search = dense(norm_search)
        idx = dense_content.find(dense_search)
        if idx!= -1 and len(dense_search) > 20: # solo para bloques grandes
            # Mapea de vuelta a posición original
            pos = 0
            start = 0
            for i, c in enumerate(norm_content):
                if not c.isspace():
                    if pos == idx:
                        start = i
                        break
                    pos += 1
            # Encuentra fin aproximado
            end = start + len(norm_search) + 50
            return {'found': True, 'method': 'dense', 'index': start, 'approx_end': end}

        # 7. Difflib fuzzy (último recurso)
        import difflib
        best_ratio = 0
        best_match = ''
        search_len = len(norm_search.split('\n'))
        for i in range(len(file_lines) - search_len + 1):
            window = '\n'.join(file_lines[i:i+search_len+2])
            ratio = difflib.SequenceMatcher(None, dense(window), dense_search).ratio()
            if ratio > best_ratio:
                best_ratio = ratio
                best_match = window
        if best_ratio > 0.85:
            return {'found': True, 'method': f'fuzzy_{best_ratio:.2f}', 'exact_text': best_match}

        return {'found': False}

    def _find_suggestions(self, file_content: str, search_text: str, max_results: int = 5) -> list:
        """Búsqueda permisiva para sugerencias cuando falla el match exacto."""
        import difflib

        norm_content = file_content.replace('\r\n', '\n').replace('\r', '\n')
        norm_search = search_text.replace('\r\n', '\n').replace('\r', '\n')
        file_lines = norm_content.split('\n')
        search_lines = [l for l in norm_search.split('\n') if l.strip()]

        if not search_lines:
            return []

        def dense(t): return ''.join(t.split())
        dense_search = dense(norm_search)
        search_len = len(search_lines)

        candidates = []
        # Ventana de búsqueda: tamaño del bloque +3-3 líneas
        for window_size in range(max(1, search_len - 2), min(len(file_lines), search_len + 4) + 1):
            for i in range(len(file_lines) - window_size + 1):
                window_lines = file_lines[i:i + window_size]
                window_text = '\n'.join(window_lines)

                # Score combinado: similitud densa + similitud de estructura
                dense_ratio = difflib.SequenceMatcher(None, dense(window_text), dense_search).ratio()

                # Bonus por coincidir primera/última línea
                first_match = 0.1 if search_lines and window_lines and search_lines[0].strip() in window_lines[0] else 0
                last_match = 0.1 if search_lines and window_lines and search_lines[-1].strip() in window_lines[-1] else 0

                score = dense_ratio + first_match + last_match

                if score > 0.55: # Threshold muy permisivo
                    # Construye preview con contexto
                    start_ctx = max(0, i - 2)
                    end_ctx = min(len(file_lines), i + window_size + 2)
                    preview_lines = []
                    for j in range(start_ctx, end_ctx):
                        prefix = '>>> ' if i <= j < i + window_size else '    '
                        preview_lines.append(f"{prefix}{file_lines[j]}")

                    candidates.append({
                        'line': i + 1,
                        'score': round(score, 2),
                        'preview': '\n'.join(preview_lines[:10]), # Máx 10 líneas
                        'matched_text': window_text,
                        'method': 'suggestion'
                    })

        # Ordena por score y elimina duplicados cercanos
        candidates.sort(key=lambda x: x['score'], reverse=True)
        filtered = []
        for c in candidates:
            if not any(abs(c['line'] - f['line']) < 3 for f in filtered):
                filtered.append(c)
            if len(filtered) >= max_results:
                break

        return filtered

    def _apply_replace(self, content: str, search: str, replace: str) -> dict:
        """Aplica reemplazo usando estrategias fuzzy. Retorna dict con resultado."""
        has_crlf = '\r\n' in content
        content_lf = content.replace('\r\n', '\n')
        search_lf = search.replace('\r\n', '\n')
        replace_lf = replace.replace('\r\n', '\n')

        match = self._find_match(content_lf, search_lf)
        if not match['found']:
            # Falló: busca sugerencias permisivas
            suggestions = self._find_suggestions(content_lf, search_lf, max_results=5)
            return {
                'success': False,
                'error': 'Search text not found',
                'suggestions': suggestions,
                'needs_confirmation': len(suggestions) > 0
            }

        # Determina qué texto reemplazar
        if 'exact_text' in match:
            old_text = match['exact_text']
        elif 'norm_content' in match:
            old_text = match['norm_search']
            content_lf = match['norm_content']
        else:
            old_text = search_lf

        new_lf = content_lf.replace(old_text, replace_lf, 1)
        result = new_lf.replace('\n', '\r\n') if has_crlf else new_lf

        return {
            'success': True,
            'content': result,
            'method': match.get('method', 'exact')
        }

    # ─── Apply ───
    def apply_all_pending(self, prompt=''):
        snapshot = self._git_snapshot()
        results = []

        for c in self.pending_changes:
            try:
                p = self.project_path / c['path']
                if c['action'] == 'CREATE_FILE':
                    p.parent.mkdir(parents=True, exist_ok=True)
                    p.write_text(c.get('content', ''), encoding='utf-8')
                elif c['action'] == 'REPLACE_IN_FILE':
                    cur = p.read_text(encoding='utf-8')
                    result = self._apply_replace(cur, c['search_text'], c['replace_text'])

                    if not result['success']:
                        # Guarda sugerencias para confirmación manual
                        c['status'] = 'needs_confirmation'
                        c['suggestions'] = result.get('suggestions', [])
                        results.append({
                            'id': c['id'],
                            'success': False,
                            'error': result['error'],
                            'needs_confirmation': True,
                            'suggestions': result.get('suggestions', [])
                        })
                        continue

                    p.write_text(result['content'], encoding='utf-8')
                    c['method_used'] = result.get('method')
                elif c['action'] == 'DELETE_FILE':
                    if p.exists(): p.unlink()

                c['status'] = 'applied'
                results.append({'id': c['id'], 'success': True})
            except Exception as e:
                c['status'] = 'error'
                results.append({'id': c['id'], 'success': False, 'error': str(e)})

        # Log batch as single history entry
        applied_count = sum(1 for r in results if r.get('success'))
        if applied_count > 0:
            try:
                self._log('BATCH', f'{applied_count} archivos', 'applied', snapshot, prompt, applied_count)
            except Exception:
                pass

        return {'results': results, 'snapshot_hash': snapshot, 'files': self.get_file_tree()}

    def undo_to_snapshot(self, snapshot_hash: str):
        if not self.project_path or not snapshot_hash:
            return {'success': False, 'error': 'Invalid request'}
        res = self._run_git(['reset', '--hard', snapshot_hash])
        if res.returncode == 0:
            self._run_git(['clean', '-fd'])
            return {'success': True}
        return {'success': False, 'error': res.stderr}

    def check_pending_changes(self):
        """Dry-run: verifica si todos los REPLACE_IN_FILE pueden encontrar su search_text."""
        if not self.project_path:
            return {'conflicts': []}
        conflicts = []
        for c in self.pending_changes:
            if c['action'] != 'REPLACE_IN_FILE':
                continue
            try:
                content = (self.project_path / c['path']).read_text(encoding='utf-8')
                content_lf = content.replace('\r\n', '\n')
                search_lf = c['search_text'].replace('\r\n', '\n')
                match = self._find_match(content_lf, search_lf)
                if not match['found']:
                    suggestions = self._find_suggestions(content_lf, search_lf, max_results=4)
                    conflicts.append({
                        'id': c['id'],
                        'path': c['path'],
                        'search_text': c['search_text'],
                        'replace_text': c['replace_text'],
                        'suggestions': suggestions
                    })
            except FileNotFoundError:
                pass  # El archivo no existe: fallará en apply con error individual, sin bloquear otros cambios
            except Exception as e:
                conflicts.append({'id': c['id'], 'path': c['path'], 'search_text': c.get('search_text', ''), 'replace_text': c.get('replace_text', ''), 'suggestions': [], 'error': str(e)})
        return {'conflicts': conflicts}

    def resolve_conflict(self, change_id: int, matched_text: str):
        """Reemplaza el search_text de un cambio pendiente con el candidato elegido."""
        for c in self.pending_changes:
            if c['id'] == change_id:
                c['search_text'] = matched_text
                return {'success': True}
        return {'success': False, 'error': 'Change not found'}

    # ─── History ───
    def _init_db(self):
        tinc_dir = self.project_path / '.tinc'
        tinc_dir.mkdir(exist_ok=True)
        self.db_path = tinc_dir / 'history.db'
        conn = sqlite3.connect(str(self.db_path))
        conn.execute('''CREATE TABLE IF NOT EXISTS history (
            id INTEGER PRIMARY KEY, timestamp TEXT, action TEXT,
            path TEXT, status TEXT, snapshot TEXT, prompt TEXT, changes_count INTEGER DEFAULT 1)''')
        # Migration for existing DBs
        for col in ['snapshot TEXT', 'prompt TEXT', 'changes_count INTEGER DEFAULT 1']:
            try:
                conn.execute(f'ALTER TABLE history ADD COLUMN {col}')
            except:
                pass
        conn.commit()
        conn.close()

    def _get_recent_file(self):
        home = Path.home()
        tinc_dir = home / '.tinc'
        tinc_dir.mkdir(exist_ok=True)
        return tinc_dir / 'recent.json'

    def get_recent_projects(self):
        try:
            f = self._get_recent_file()
            if f.exists():
                data = json.loads(f.read_text())
                return [p for p in data if Path(p['path']).exists()][:10]
        except:
            pass
        return []

    def _save_recent_project(self, path: str):
        try:
            f = self._get_recent_file()
            recents = []
            if f.exists():
                recents = json.loads(f.read_text())
            recents = [r for r in recents if r['path'] != path]
            recents.insert(0, {
                'path': path,
                'name': Path(path).name,
                'last_opened': datetime.now().isoformat()
            })
            f.write_text(json.dumps(recents[:10], indent=2))
        except:
            pass

    def _log(self, action, path, status, snapshot='', prompt='', changes_count=1):
        if not self.db_path: return
        conn = sqlite3.connect(str(self.db_path))
        conn.execute('INSERT INTO history (timestamp, action, path, status, snapshot, prompt, changes_count) VALUES (?,?,?,?,?,?,?)',
                    (datetime.now().strftime('%H:%M:%S'), action, path, status, snapshot, prompt, changes_count))
        conn.commit()
        conn.close()

    def get_session_history(self):
        if not self.db_path: return []
        conn = sqlite3.connect(str(self.db_path))
        rows = conn.execute('SELECT timestamp,action,path,status,snapshot,prompt,changes_count FROM history ORDER BY id DESC LIMIT 200').fetchall()
        conn.close()
        return [{'time': r[0], 'action': r[1], 'path': r[2], 'status': r[3], 'snapshot': r[4], 'prompt': r[5], 'changes': r[6] or 1} for r in rows]
