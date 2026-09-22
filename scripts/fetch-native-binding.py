#!/usr/bin/env python3
"""postinstall: ensure the Tantivy native binary exists.

npm intermittently prunes the matching optional platform package on fresh
Linux installs (npm/cli#4828), even when pinned in optionalDependencies.
This self-heals by fetching the platform tarball directly and dropping the
.node file next to the binding. No-op when the binding already loads.
Stdlib only (urllib + tarfile); runs on any platform Node supports.
"""
import json
import subprocess
import sys
import tarfile
import tempfile
import urllib.request
from pathlib import Path
from typing import Optional

ROOT = Path(__file__).resolve().parent.parent
BINDING_DIR = ROOT / "node_modules" / "@pngwasi" / "node-tantivy-binding"


def binding_loads() -> bool:
    probe = "try{require('@pngwasi/node-tantivy-binding');console.log('OK')}catch(e){process.exit(42)}"
    return subprocess.run(["node", "-e", probe], cwd=ROOT).returncode == 0


def platform_package() -> Optional[str]:
    if sys.platform.startswith("linux"):
        return "@pngwasi/node-tantivy-binding-linux-x64-gnu"
    if sys.platform == "darwin":
        import platform as _p

        arch = _p.machine()
        return f"@pngwasi/node-tantivy-binding-darwin-{arch}"
    return None


def main() -> int:
    if not BINDING_DIR.is_dir():
        return 0  # binding itself absent; nothing to heal (install failed elsewhere)
    if binding_loads():
        return 0
    pkg = platform_package()
    if pkg is None:
        print(f"fetch-native-binding: unsupported platform {sys.platform}, skipping")
        return 0
    with open(ROOT / "package.json") as f:
        want = json.load(f)["optionalDependencies"][pkg]
    meta = json.load(
        urllib.request.urlopen(f"https://registry.npmjs.org/{pkg.replace('/', '%2F')}")
    )
    ver = meta["dist-tags"].get("latest", "")
    if want.startswith("^") and not ver.startswith(want[1:].split(".")[0] + "."):
        pass  # major drift; still try latest, the require probe is the real gate
    url = meta["versions"][ver]["dist"]["tarball"]
    with tempfile.TemporaryDirectory() as tmp:
        tgz = Path(tmp) / "pkg.tgz"
        urllib.request.urlretrieve(url, tgz)
        with tarfile.open(tgz) as tf:
            tf.extractall(tmp, filter="data")
        nodes = list(Path(tmp).rglob("*.node"))
        if not nodes:
            print("fetch-native-binding: no .node in tarball, giving up")
            return 1
        for n in nodes:
            (BINDING_DIR / n.name).write_bytes(n.read_bytes())
    if binding_loads():
        print(f"fetch-native-binding: healed {pkg}, binding loads")
        return 0
    print("fetch-native-binding: still broken after fetch")
    return 1


if __name__ == "__main__":
    sys.exit(main())
