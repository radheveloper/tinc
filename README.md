# λ TINC — This Is Not Copilot

> A local desktop vibe-coding agent that bridges your codebase with any external AI (Claude, ChatGPT, Gemini…) — no subscriptions, no plugins, no IDE lock-in.



## What is TINC?

TINC is a lightweight desktop app that turns any AI chat into a surgical code editor. You describe what you want, TINC packages your project files into a context prompt, you paste the AI's response back in, and TINC applies the changes — file by file, with fuzzy matching, conflict resolution, and Git-powered undo.

No API keys. No monthly fees. Works with any AI.



## How it works

[![Demo here](https://img.youtube.com/vi/ZD8JoAy292M/0.jpg)](https://www.youtube.com/watch?v=ZD8JoAy292M)

```
Your project files
      ↓
  TINC builds a structured prompt with full file context
      ↓
  You paste it into any AI chat (Claude, ChatGPT, AI Studio…)
      ↓
  You paste the response back into TINC
      ↓
  TINC parses and applies the changes to your files
      ↓
  Git snapshot — one-click undo if anything goes wrong
```

TINC does **not** call any AI API itself. That's the point — you control which AI you use, which model, which account.


## Download

| Platform | Download |
|----------|----------|
| 🪟 Windows |[TINC-windows.zip](https://github.com/radheveloper/tinc/releases/latest/download/TINC-windows.zip) |
| 🐧 Linux | [TINC-linux.tar.gz](https://github.com/radheveloper/tinc/releases/latest/download/TINC-linux.tar.gz) |
| 🍎 macOS | [TINC-macos.zip](https://github.com/radheveloper/tinc/releases/latest/download/TINC-macos.zip) |
   
No installation needed. Unzip and run.


## Features

- **File tree with selective context** — choose exactly which files go into the prompt. The fewer files, the sharper the AI response.
- **Surgical edits** — TINC applies `REPLACE_IN_FILE` changes instead of rewriting whole files. Fuzzy matching handles minor whitespace differences.
- **Conflict resolver** — if the AI's search block doesn't match your local file exactly, TINC shows you the closest candidates and lets you pick.
- **Git snapshots on every apply** — every batch of changes is committed automatically. One click to undo to any previous state.
- **Session history** — full log of every prompt and change set, with undo buttons.
- **Auto-copy prompts** — the generated prompt goes straight to your clipboard.
- **Dark / light mode** — adapts to your preference.


## Running from source

**Requirements:** Python 3.10+, pip

```bash
git clone https://github.com/radheveloper/tinc.git
cd tinc
pip install -r requirements.txt
python main.py
```

> On Linux you may also need: `sudo apt install libglib2.0-0 libgl1 libegl1 libxcb-cursor0`


## Usage

1. **Open a project** — click the folder icon and select your project directory.
2. **Select files** — check the files you want to include as context (select only what's relevant).
3. **Write an instruction** — describe what you want in plain language. *"Add a dark mode toggle to the settings panel"*, *"Refactor the database connection to use a connection pool"*.
4. **Copy the prompt** — TINC generates a structured prompt and copies it to your clipboard automatically.
5. **Paste into your AI** — open Claude, ChatGPT, Gemini, or any chat interface and paste.
6. **Paste the response back** — copy the full AI response and paste it into TINC's response field.
7. **Review and apply** — TINC shows you every change before applying. If there are conflicts, it walks you through them.
8. **Undo if needed** — the History panel shows every apply with an Undo button that reverts via git.


## Building from source

```bash
pip install pyinstaller
pyinstaller tinc.spec
# Output in dist/TINC/
```
