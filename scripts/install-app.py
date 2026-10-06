#!/usr/bin/env python3
"""Install an audited local build; user state never becomes application payload."""
import argparse
import datetime
import importlib.util
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--destination', type=Path, default=Path('/Applications/Eido.app'))
    parser.add_argument('--migrate-development', action='store_true')
    args = parser.parse_args()
    destination = args.destination.expanduser().resolve()
    if destination.name != 'Eido.app':
        raise RuntimeError('The installation destination must be named Eido.app')
    processes = subprocess.check_output(['ps', 'ax', '-o', 'command='], text=True).splitlines()
    if any('/Eido.app/Contents/MacOS/eido' in line or '/packages/acp/src/cli.' in line for line in processes):
        raise RuntimeError('Quit Eido and its ACP processes before installing')
    spec = importlib.util.spec_from_file_location('eido_package', ROOT / 'scripts/package-app.py')
    package = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(package)
    source = ROOT / '.local/package-stage/Eido.app'
    package.audit(source)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', source], check=True)
    if destination.exists():
        with (destination / 'Contents/Info.plist').open('rb') as stream:
            if plistlib.load(stream).get('CFBundleIdentifier') != 'dev.eido.app':
                raise RuntimeError('Refusing to replace an unrelated application')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_name(f'.Eido-install-{os.getpid()}.app')
    # macOS stores script signatures in extended attributes; copy2/copytree
    # loses those attributes and produces an app with an invalid deep signature.
    subprocess.run(['ditto', source, temporary], check=True)
    package.audit(temporary)
    subprocess.run(['codesign', '--verify', '--deep', '--strict', temporary], check=True)
    if destination.exists():
        backup = ROOT / '.local/installed-backups' / datetime.datetime.now().strftime('%Y%m%d-%H%M%S') / 'Eido.app'
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.move(destination, backup)
    temporary.rename(destination)
    if args.migrate_development:
        migrate(destination)
    print(f'Installed {destination}')


def migrate(bundle):
    data = Path.home() / 'Library/Application Support/Eido'
    pi = data / 'pi'
    native = data / 'native'
    # One-time opt-in migration. Never overwrite a user's installed profile.
    if pi.exists() or native.exists():
        print('Existing installed user state preserved; migration skipped.')
        return
    data.mkdir(parents=True, exist_ok=True, mode=0o700)
    stage = data / f'.migration-{os.getpid()}'
    stage.mkdir(mode=0o700)
    (stage / 'pi').mkdir(mode=0o700)
    for name in ('settings.json', 'auth.json', 'models.json', 'models-store.json', 'mcp.json', 'mcp-auth.json'):
        source = ROOT / '.local/eido' / name
        if source.is_file():
            shutil.copy2(source, stage / 'pi' / name)
            (stage / 'pi' / name).chmod(0o600)
    for name in ('acp-sessions', 'agents', 'skills', 'prompts', 'extensions', 'npm', 'git'):
        source = ROOT / '.local/eido' / name
        if source.is_dir():
            shutil.copytree(source, stage / 'pi' / name)
    (stage / 'native').mkdir(mode=0o700)
    for name in ('db', 'config'):
        source = ROOT / '.local/native-config' / name
        if source.is_dir():
            shutil.copytree(source, stage / 'native' / name)
    settings = stage / 'native/config/settings.json'
    if settings.exists():
        value = json.loads(settings.read_text())
        node = str(bundle / 'Contents/Helpers/node')
        runtime = bundle / 'Contents/Resources/runtime'
        value['node'] = {'path': node, 'ignore_system_version': False}
        value.setdefault('agent_servers', {})['eido-pi'] = {'type': 'custom', 'command': node,
            'args': [str(runtime / 'packages/acp/src/cli.js')],
            'env': {'EIDO_ROOT': str(runtime), 'EIDO_PI_CONFIG_DIR': str(pi), 'PI_CODING_AGENT_DIR': str(pi)}}
        settings.write_text(json.dumps(value, indent=2) + '\n')
    (stage / 'pi').rename(pi)
    (stage / 'native').rename(native)
    stage.rmdir()
    print('Migrated existing pi configuration and native workspace state to user storage; originals preserved.')


if __name__ == '__main__':
    main()
