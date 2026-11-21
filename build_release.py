#!/usr/bin/env python3
"""Build the Python-free release archive from Herdr App v0.1.16 defaults."""

import argparse
from pathlib import Path
import shutil
import tempfile

from install import BUNDLE, LAYOUT, install, prepare


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("defaults", type=Path, help="Herdr App v0.1.16 defaults directory")
    parser.add_argument("output", type=Path, help="Output directory")
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    layout, sources = prepare(args.defaults)
    with tempfile.TemporaryDirectory() as temp:
        bundle = Path(temp) / "herdr-devvm-mod"
        (bundle / "layouts").mkdir(parents=True)
        (bundle / "mods").mkdir()
        install(bundle, bundle / "layouts" / f"{LAYOUT}.json", layout, sources)
        for name in ("install.sh", "README.md", "LICENSE"):
            shutil.copyfile(BUNDLE / name, bundle / name)
        shutil.copyfile(args.defaults.parent / "LICENSE", bundle / "LICENSE.herdr-app")
        archive = shutil.make_archive(str(args.output / bundle.name), "gztar", temp, bundle.name)
        print(archive)


if __name__ == "__main__":
    main()
