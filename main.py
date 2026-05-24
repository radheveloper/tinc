import webview
import os
import sys
from backend import TINCBackend

def main():
    api = TINCBackend()
    base = sys._MEIPASS if getattr(sys, 'frozen', False) else os.path.dirname(os.path.abspath(__file__))
    ui_path = os.path.join(base, 'ui', 'index.html')

    window = webview.create_window(
        title='TINC – This is not Copilot',
        url=f'file:///{ui_path}',
        js_api=api,
        width=900,
        height=600,
        min_size=(900, 600),
        background_color='#0a0a0a',
    )
    
    gui = None
    try:
        import gi
    except ImportError:
        # Fall back to Qt since PyQt5 is specified in requirements.txt
        gui = 'qt'

    webview.start(gui=gui, debug='--debug' in sys.argv)

if __name__ == '__main__':
    main()
