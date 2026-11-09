"""Build a single-file executable with PyInstaller.

    pip install pyinstaller
    python build.py

Output goes to dist/ (DispatchRPM.exe on Windows, DispatchRPM elsewhere).
"""

import os
import subprocess
import sys

subprocess.run([
    sys.executable, "-m", "PyInstaller", "dispatch_rpm/__main__.py",
    "--name", "DispatchRPM",
    "--onefile",
    "--windowed",
    "--noconfirm",
    "--clean",
    "--paths", ".",
    "--add-data", f"dispatch_rpm/static{os.pathsep}dispatch_rpm/static",
], check=True)
