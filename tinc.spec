# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for TINC
# Run with: pyinstaller tinc.spec

import sys
import os
from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

# ── Collect data files ──────────────────────────────────────────────────────

# tiktoken needs its encoding .tiktoken files
tiktoken_datas = collect_data_files('tiktoken', includes=['*.tiktoken'])

# pywebview may need its own assets depending on platform
pywebview_datas = collect_data_files('webview')

# Our UI folder
ui_datas = [('ui', 'ui')]

all_datas = tiktoken_datas + pywebview_datas + ui_datas

# ── Hidden imports ───────────────────────────────────────────────────────────
# pywebview and PyQtWebEngine don't always get picked up automatically

hidden_imports = [
    # pywebview Qt backend
    'webview',
    'webview.platforms.qt',
    # PyQt5 essentials
    'PyQt5',
    'PyQt5.QtCore',
    'PyQt5.QtGui',
    'PyQt5.QtWidgets',
    'PyQt5.QtWebEngineWidgets',
    'PyQt5.QtWebEngineCore',
    'PyQt5.QtWebChannel',
    'PyQt5.QtNetwork',
    'PyQt5.QtPrintSupport',
    # qtpy abstraction layer
    'qtpy',
    # tiktoken internals
    'tiktoken',
    'tiktoken.core',
    'tiktoken_ext',
    'tiktoken_ext.openai_public',
    # stdlib used explicitly
    'sqlite3',
    'difflib',
    'fnmatch',
]

# ── Analysis ─────────────────────────────────────────────────────────────────

a = Analysis(
    ['main.py'],
    pathex=[],
    binaries=[],
    datas=all_datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Save space — we don't need these
        'matplotlib',
        'numpy',
        'pandas',
        'PIL',
        'scipy',
        'IPython',
        'jupyter',
        'tkinter',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

# ── Executable ───────────────────────────────────────────────────────────────

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,         # one-folder mode (recommended for Qt)
    name='TINC',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,                      # compress binaries if UPX is installed
    console=False,                 # no terminal window on Windows/macOS
    disable_windowed_traceback=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # Windows only — swap for your own .ico if you have one
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[
        # Qt DLLs break when compressed with UPX
        'Qt5Core.dll', 'Qt5Gui.dll', 'Qt5Widgets.dll',
        'Qt5WebEngineCore.dll', 'Qt5WebEngineWidgets.dll',
        'libQt5Core.so*', 'libQt5WebEngine*.so*',
    ],
    name='TINC',
)

# ── macOS .app bundle ────────────────────────────────────────────────────────
# Only active when building on macOS

if sys.platform == 'darwin':
    app = BUNDLE(
        coll,
        name='TINC.app',
        icon=None,                 # replace with 'assets/tinc.icns' if you have one
        bundle_identifier='com.tinc.app',
        info_plist={
            'NSHighResolutionCapable': True,
            'NSRequiresAquaSystemAppearance': False,  # allow dark mode
            'CFBundleShortVersionString': '1.0.0',
            'CFBundleName': 'TINC',
        },
    )