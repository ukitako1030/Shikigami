#!/usr/bin/env python3
"""Private X11 display. JSON lines on stdio; never connects to WSLg or host input."""
import base64
import argparse
import ctypes
import datetime
import fcntl
import io
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import signal
import stat
import struct
import subprocess
import sys
import time
from urllib.parse import urlsplit

from PIL import Image


def cleanup_session(session_id):
    if not re.fullmatch(r'[a-f0-9]{24}', session_id):
        raise ValueError('Invalid session identity')
    marker = b'SHIKIGAMI_LAB_SESSION=' + session_id.encode() + b'\0'
    def signal_owned(sig):
        found = []
        for proc in Path('/proc').glob('[0-9]*'):
            fd = None
            try:
                pid = int(proc.name)
                if pid == os.getpid() or proc.stat().st_uid != os.getuid():
                    continue
                fd = os.pidfd_open(pid)
                if marker not in (proc / 'environ').read_bytes():
                    continue
                if sig:
                    signal.pidfd_send_signal(fd, sig)
                found.append(pid)
            except (OSError, ValueError):
                pass
            finally:
                if fd is not None:
                    os.close(fd)
        return found
    signal_owned(signal.SIGTERM)
    time.sleep(.25)
    signal_owned(signal.SIGKILL)
    time.sleep(.1)
    return {'remaining': signal_owned(None)}


if len(sys.argv) == 3 and sys.argv[1] == '--cleanup':
    print(json.dumps(cleanup_session(sys.argv[2])))
    raise SystemExit(0)

parser = argparse.ArgumentParser()
parser.add_argument('--workspace', default=secrets.token_hex(12))
parser.add_argument('--read-files', action='store_true')
parser.add_argument('--read-file')
options = parser.parse_args()
if not re.fullmatch(r'[a-f0-9]{24}', options.workspace):
    raise ValueError('Invalid workspace identity')
persistent = Path.home() / 'workspaces' / options.workspace
files = persistent / 'files'
files.mkdir(mode=0o700, parents=True, exist_ok=True)
MAX_FILE = 20 * 1024 * 1024


def valid_name(name):
    return (isinstance(name, str) and 0 < len(name) <= 255 and name not in ('.', '..')
            and not any(c in name for c in '/\\') and not any(ord(c) < 32 for c in name))


def file_list():
    entries = []
    directory = os.open(files, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        with os.scandir(directory) as items:
            for item in items:
                if not valid_name(item.name) or not item.is_file(follow_symlinks=False):
                    continue
                try:
                    info = item.stat(follow_symlinks=False)
                except FileNotFoundError:
                    continue
                entries.append({'name': item.name, 'size': info.st_size,
                                'modifiedAt': datetime.datetime.fromtimestamp(
                                    info.st_mtime, datetime.timezone.utc).isoformat()})
                if len(entries) >= 1000:
                    break
    finally:
        os.close(directory)
    return {'files': entries, 'workspacePath': str(files)}


def read_file(name):
    if not valid_name(name):
        raise ValueError('Invalid file name')
    directory = os.open(files, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
        with os.fdopen(fd, 'rb') as stream:
            info = os.fstat(stream.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_size > MAX_FILE:
                raise ValueError('Only regular files up to 20 MiB can be read')
            content = stream.read(MAX_FILE + 1)
            if len(content) > MAX_FILE:
                raise ValueError('File exceeds 20 MiB')
    finally:
        os.close(directory)
    return {'name': name, 'size': len(content),
            'mimeType': mimetypes.guess_type(name)[0] or 'application/octet-stream',
            'data': base64.b64encode(content).decode('ascii')}


if options.read_files or options.read_file is not None:
    print(json.dumps(file_list() if options.read_files else read_file(options.read_file), ensure_ascii=False))
    raise SystemExit(0)

workspace_lock = (persistent / '.lock').open('a')
try:
    fcntl.flock(workspace_lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    raise RuntimeError('This workspace is already running')
(persistent / 'home').mkdir(mode=0o700, exist_ok=True)
WIDTH, HEIGHT = 1100, 740
BASE = Path.home() / 'sessions'
BASE.mkdir(mode=0o700, parents=True, exist_ok=True)
work = BASE / secrets.token_hex(12)
work.mkdir(mode=0o700)
(work / 'runtime').mkdir(mode=0o700)
note = files / '作業メモ.txt'
test_note = files / 'Shikigami-note.txt'
log = (work / 'process.log').open('ab', buffering=0)
children = []
display = None
env = dict(os.environ)
for variable in ('DISPLAY', 'WAYLAND_DISPLAY', 'DBUS_SESSION_BUS_ADDRESS',
                 'PULSE_SERVER', 'WSL_INTEROP', 'XAUTHORITY', 'XDG_RUNTIME_DIR'):
    env.pop(variable, None)
env.update(HOME=str(persistent / 'home'), XDG_RUNTIME_DIR=str(work / 'runtime'),
           PATH='/usr/bin:/bin',
           SHIKIGAMI_LAB_SESSION=work.name,
           GDK_BACKEND='x11', QT_QPA_PLATFORM='xcb', LANG='C.UTF-8', LC_ALL='C.UTF-8',
           XAUTHORITY=str(work / 'Xauthority'))


def run(args, **kwargs):
    return subprocess.run(args, env=env, check=True, capture_output=True, timeout=8, **kwargs)


def parent_death():
    # A crashed worker must not leave its X server running indefinitely.
    libc = ctypes.CDLL(None)
    if libc.prctl(1, signal.SIGTERM) != 0:
        raise OSError('Cannot establish child lifetime ownership')


def child(args):
    p = subprocess.Popen(args, env=env, stdin=subprocess.DEVNULL, stdout=log,
                         stderr=log, start_new_session=True, preexec_fn=parent_death)
    children.append(p)
    return p


def xdo(*args):
    return run(['xdotool', *map(str, args)]).stdout.decode('utf-8').strip()


def running():
    return bool(children and children[0].poll() is None and display)


def start():
    global display
    if running():
        return status()
    if children:
        raise RuntimeError('The display exited. Stop and restart the workspace.')
    for number in range(191, 240):
        if not Path(f'/tmp/.X11-unix/X{number}').exists() and not Path(f'/tmp/.X{number}-lock').exists():
            display = f':{number}'
            break
    if display is None:
        raise RuntimeError('No private display number is available.')
    env['DISPLAY'] = display
    os.environ['XAUTHORITY'] = env['XAUTHORITY']
    run(['xauth', '-f', env['XAUTHORITY'], 'add', display, 'MIT-MAGIC-COOKIE-1', secrets.token_hex(16)])
    child(['Xvfb', display, '-screen', '0', f'{WIDTH}x{HEIGHT}x24', '-nolisten', 'tcp',
           '-auth', env['XAUTHORITY'], '-fbdir', str(work), '-noreset'])
    for _ in range(60):
        if not running():
            raise RuntimeError('Private display failed: ' + (work / 'process.log').read_text(errors='replace')[-1000:])
        try:
            xdo('getdisplaygeometry')
            break
        except subprocess.CalledProcessError:
            time.sleep(.1)
    else:
        raise RuntimeError('Private display did not become ready.')
    child(['openbox', '--sm-disable'])
    time.sleep(.25)
    x11 = ctypes.CDLL('libX11.so.6')
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
    x11.XDefaultRootWindow.restype = ctypes.c_ulong
    x11.XSetWindowBackground.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong]
    x11.XClearWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XCloseDisplay.argtypes = [ctypes.c_void_p]
    connection = x11.XOpenDisplay(display.encode())
    if not connection:
        raise RuntimeError('Cannot paint the private display')
    root_window = x11.XDefaultRootWindow(connection)
    x11.XSetWindowBackground(connection, root_window, 0x10283d)
    x11.XClearWindow(connection, root_window)
    x11.XCloseDisplay(connection)
    return status()


def memory():
    # PSS apportions shared pages; RSS does not. Neither includes the WSL VM itself.
    parents = {}
    for item in Path('/proc').glob('[0-9]*'):
        try:
            fields = (item / 'stat').read_text().rsplit(')', 1)[1].split()
            parents[int(item.name)] = int(fields[1])
        except (OSError, ValueError, IndexError):
            pass
    pids = {os.getpid()}
    pids.update(p.pid for p in children if p.poll() is None)
    for _ in range(12):
        more = {pid for pid, parent in parents.items() if parent in pids} - pids
        if not more:
            break
        pids.update(more)
    rss = pss = 0
    for pid in pids:
        try:
            lines = Path(f'/proc/{pid}/smaps_rollup').read_text().splitlines()
            for line in lines:
                if line.startswith('Rss:'):
                    rss += int(line.split()[1])
                if line.startswith('Pss:'):
                    pss += int(line.split()[1])
        except OSError:
            pass
    return {'rssMiB': round(rss / 1024, 1), 'pssMiB': round(pss / 1024, 1), 'processCount': len(pids)}


def status():
    return {'running': running(), 'display': display, 'memory': memory(),
            'width': WIDTH, 'height': HEIGHT, 'sessionId': work.name,
            'workspace': str(files), 'notePath': str(note)}


def windows():
    try:
        ids = xdo('search', '--onlyvisible', '--name', '.').splitlines()
    except subprocess.CalledProcessError as error:
        if error.returncode == 1:
            return []
        raise
    result = []
    for wid in ids:
        try:
            name = xdo('getwindowname', wid)
            if name:
                result.append({'id': wid, 'title': name})
        except subprocess.CalledProcessError:
            pass
    return result


def launch(app, test=False):
    if app == 'editor':
        editor_note = test_note if test else note
        try:
            with editor_note.open('x', encoding='utf-8'):
                pass
        except FileExistsError:
            pass
        matches = [w for w in windows() if editor_note.name in w['title'] and 'Mousepad' in w['title']]
        if matches:
            xdo('windowactivate', '--sync', matches[0]['id'])
        else:
            child(['dbus-run-session', '--', 'mousepad', '--disable-server', str(editor_note)])
        target = editor_note.name
    elif app == 'calculator':
        matches = [w for w in windows() if w['title'] == 'Calculator']
        if matches:
            xdo('windowactivate', '--sync', matches[0]['id'])
        else:
            child(['xcalc', '-title', 'Calculator', '-geometry', '300x420+755+140'])
        target = 'Calculator'
    elif app == 'chrome':
        target = 'Google Chrome'
        matches = [w for w in windows() if target in w['title']]
        if not matches:
            profile = persistent / 'home' / 'chrome'
            preferences = profile / 'Default' / 'Preferences'
            if not preferences.exists():
                preferences.parent.mkdir(parents=True, exist_ok=True)
                preferences.write_text(json.dumps({'download': {'default_directory': str(files),
                    'prompt_for_download': False}, 'browser': {'check_default_browser': False}}))
            child(['google-chrome-stable', '--user-data-dir=' + str(profile),
                   '--no-first-run', '--no-default-browser-check', '--disable-dev-shm-usage',
                   '--ozone-platform=x11',
                   '--window-size=1060,680', '--window-position=20,25', 'about:blank'])
    elif app == 'files':
        target = 'files'
        matches = [w for w in windows() if w['title'] == target]
        if not matches:
            child(['dbus-run-session', '--', 'pcmanfm', '--new-win', str(files)])
    else:
        raise ValueError('Unknown app')
    def matches_target(title):
        if app == 'editor':
            return title.endswith(editor_note.name + ' - Mousepad')
        if app in ('files', 'calculator'):
            return title == target
        return title.endswith(' - Google Chrome') or title == 'Google Chrome'
    for _ in range(120):
        matches = [w for w in windows() if matches_target(w['title'])]
        if matches:
            wid = matches[0]['id']
            if app == 'editor':
                xdo('windowsize', wid, 720, 590)
                xdo('windowmove', wid, 25, 50)
            xdo('windowactivate', '--sync', wid)
            return {'windows': windows()}
        time.sleep(.1)
    raise RuntimeError('Application did not open: ' + (work / 'process.log').read_text(errors='replace')[-1000:])


def capture():
    data = (work / 'Xvfb_screen0').read_bytes()
    header = struct.unpack('>25I', data[:100])
    size, version, fmt, depth, width, height, xoffset, order, unit, bitorder, pad, bpp, stride, visual, red, green, blue, bits, cmap, ncolors, *_ = header
    if version != 7 or fmt != 2 or bpp != 32 or order != 0 or (red, green, blue) != (0xff0000, 0xff00, 0xff):
        raise RuntimeError('Unsupported private framebuffer format')
    pixels = data[size + ncolors * 12:]
    picture = Image.frombytes('RGB', (width, height), pixels, 'raw', 'BGRX', stride, 1)
    buffer = io.BytesIO()
    picture.save(buffer, format='PNG')
    return {'image': base64.b64encode(buffer.getvalue()).decode('ascii'),
            'width': width, 'height': height, 'capturedAt': int(time.time() * 1000)}


def dispatch(command):
    method = command.get('method')
    if method == 'start':
        return start()
    if method == 'status':
        return status()
    if method == 'stop':
        stop()
        return {'running': False}
    if not running():
        raise RuntimeError('The dedicated desktop is stopped.')
    if method == 'capture':
        return capture()
    if method == 'windows':
        return {'windows': windows()}
    if method == 'launch':
        return launch(command.get('app'), command.get('test') is True)
    if method == 'navigate':
        url = command.get('url')
        if not isinstance(url, str) or len(url) > 2048 or any(ord(c) < 32 for c in url):
            raise ValueError('Invalid URL')
        parsed = urlsplit(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname:
            raise ValueError('Only http:// and https:// URLs are supported')
        launch('chrome')
        xdo('key', '--clearmodifiers', 'ctrl+l')
        dispatch({'method': 'type', 'text': url})
        xdo('key', '--clearmodifiers', 'Return')
        return {'ok': True, 'url': url}
    if method == 'click':
        x, y, button = command.get('x'), command.get('y'), command.get('button', 1)
        if not isinstance(x, int) or not isinstance(y, int) or not (0 <= x < WIDTH and 0 <= y < HEIGHT) or button not in (1, 3):
            raise ValueError('Invalid pointer coordinates or button')
        # --sync waits for a movement event and hangs if the pointer is already there.
        xdo('mousemove', x, y, 'click', button)
    elif method == 'scroll':
        steps = command.get('steps', 3)
        if command.get('direction') not in ('up', 'down') or not isinstance(steps, int) or not 1 <= steps <= 20:
            raise ValueError('Invalid scroll')
        xdo('click', '--repeat', steps, '--delay', 65, 4 if command['direction'] == 'up' else 5)
    elif method == 'type':
        text = command.get('text')
        if not isinstance(text, str) or len(text) > 10000 or '\x00' in text:
            raise ValueError('Invalid text')
        if not text:
            return {'ok': True}
        # Clipboard belongs exclusively to this private X display, never to Windows/WSLg.
        expected = text.encode('utf-8')
        clipboard = subprocess.Popen(['xclip', '-quiet', '-selection', 'clipboard', '-loops', '0'],
                                     env=env, stdin=subprocess.PIPE, stdout=log, stderr=log,
                                     start_new_session=True, preexec_fn=parent_death)
        children.append(clipboard)
        clipboard.stdin.write(expected)
        clipboard.stdin.close()
        # Paste only after this text owns the clipboard; otherwise the previous text could be pasted.
        deadline = time.monotonic() + 1.5
        while True:
            try:
                current = subprocess.run(['xclip', '-o', '-selection', 'clipboard'], env=env,
                                         capture_output=True, timeout=max(.1, deadline - time.monotonic()))
                if current.returncode == 0 and current.stdout == expected:
                    break
            except subprocess.TimeoutExpired:
                pass
            if time.monotonic() >= deadline or clipboard.poll() is not None:
                raise RuntimeError('The private clipboard was not ready, so nothing was pasted. Try again.')
            time.sleep(.02)
        xdo('key', '--clearmodifiers', 'ctrl+v')
        time.sleep(.15)
    elif method == 'key':
        key = command.get('key')
        if key not in ('ctrl+a', 'ctrl+s', 'ctrl+o', 'ctrl+n', 'ctrl+z', 'ctrl+y', 'ctrl+f', 'ctrl+l',
                       'Return', 'Escape', 'Tab', 'BackSpace', 'Delete', 'Home', 'End',
                       'Up', 'Down', 'Left', 'Right', 'Page_Up', 'Page_Down', 'alt+F4'):
            raise ValueError('Unsupported key')
        xdo('key', '--clearmodifiers', key)
    elif method == 'read_test_note':
        return {'text': test_note.read_text(encoding='utf-8'), 'path': str(test_note)}
    else:
        raise ValueError('Unsupported desktop operation')
    return {'ok': True}


def stop():
    for p in reversed(children):
        if p.poll() is None:
            try:
                os.killpg(p.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
    for p in children:
        try:
            p.wait(timeout=1)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(p.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    children.clear()
    result = cleanup_session(work.name)
    if result['remaining']:
        raise RuntimeError('Dedicated processes did not stop: ' + str(result['remaining']))


def terminate(*_):
    stop()
    raise SystemExit(0)


signal.signal(signal.SIGTERM, terminate)
signal.signal(signal.SIGINT, terminate)
print(json.dumps({'event': 'ready', 'sessionId': work.name}), flush=True)
try:
    for line in sys.stdin:
        request = {}
        try:
            request = json.loads(line)
            result = dispatch(request)
            response = {'id': request.get('id'), 'result': result}
        except Exception as error:
            response = {'id': request.get('id'), 'error': str(error)}
        print(json.dumps(response, ensure_ascii=False), flush=True)
finally:
    stop()
