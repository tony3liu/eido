#!/usr/bin/env python3
import argparse
import hashlib
import datetime
import json
import importlib.util
import os
import plistlib
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.local'
SOURCE = LOCAL / 'upstream' / 'zed'
MANIFEST = ROOT / 'native' / 'zed.json'
STATE = LOCAL / 'native-applied.json'
BUILD_FEATURES = ['gpui_platform/runtime_shaders']


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def source_files():
    root = ROOT / 'native/overlay'
    files = []
    for path in root.rglob('*'):
        if path.is_symlink():
            raise RuntimeError('Native source links are not supported: ' + str(path))
        if path.is_file() and 'target' not in path.relative_to(root).parts:
            files.append(path.relative_to(root).as_posix())
    return sorted(files)


def removed_paths():
    values = json.loads((ROOT / 'native/removed-paths.json').read_text())
    if not isinstance(values, list):
        raise RuntimeError('Native removals must be a list of relative file paths')
    for value in values:
        if not isinstance(value, str) or not value or Path(value).is_absolute() or any(part in ('', '.', '..') for part in value.split('/')):
            raise RuntimeError('Invalid native removal path')
    return sorted(set(values))


def prepare():
    manifest = json.loads(MANIFEST.read_text())
    archive = LOCAL / 'downloads' / manifest['archiveName']
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        raise RuntimeError('Zed archive is missing. Run npm run native:fetch manually after configuring your network.')
    if digest(archive) != manifest['sha256']:
        raise RuntimeError('Local Zed archive does not match the pinned SHA-256')
    previous_state = json.loads(STATE.read_text()) if STATE.exists() else {}
    previous = previous_state.get('files', previous_state)
    overlay = ROOT / 'native' / 'overlay'
    removed = removed_paths()
    overlay_paths = source_files()
    if set(removed).intersection(overlay_paths):
        raise RuntimeError('A native source cannot be both maintained and removed')
    changed_paths = list(dict.fromkeys(removed + overlay_paths + list(previous)))
    with tempfile.TemporaryDirectory(prefix='eido-native-', dir=LOCAL) as temporary:
        clean = Path(temporary)
        subprocess.run(['tar', '-xzf', str(archive), '-C', str(clean)], check=True)
        baseline = next(clean.iterdir())
        original_hashes = {relative: digest(baseline / relative) if (baseline / relative).is_file() else None for relative in changed_paths}
        for relative in removed:
            target = baseline / relative
            if target.is_file():
                target.unlink()
        for relative in changed_paths:
            current = SOURCE / relative
            pristine = overlay / relative if relative in overlay_paths else baseline / relative
            if current.exists():
                allowed = {previous.get(relative), original_hashes.get(relative)}
                if pristine.exists():
                    allowed.add(digest(pristine))
                if digest(current) not in allowed:
                    raise RuntimeError('Local native source has edits outside the overlay; preserve them before preparing: ' + relative)
        if not SOURCE.exists():
            SOURCE.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(baseline, SOURCE)
        for relative in changed_paths:
            destination = SOURCE / relative
            desired = overlay / relative if relative in overlay_paths else baseline / relative
            if desired.is_file():
                destination.parent.mkdir(parents=True, exist_ok=True)
                if not destination.exists() or digest(desired) != digest(destination):
                    shutil.copy2(desired, destination)
            elif destination.exists():
                destination.unlink()
    STATE.write_text(json.dumps({'files': {relative: digest(SOURCE / relative) if (SOURCE / relative).is_file() else None for relative in changed_paths}, 'removedSha256': digest(ROOT / 'native/removed-paths.json'), 'upstreamSha256': digest(MANIFEST), 'maintainedFiles': overlay_paths}, indent=2))
    print('Prepared Eido on Zed', manifest['tag'], manifest['commit'])


def environment():
    result = dict(os.environ)
    toolchains = LOCAL / 'toolchains'
    cargo = toolchains / 'cargo'
    if (cargo / 'bin/cargo').exists():
        result['CARGO_HOME'] = str(cargo)
        result['RUSTUP_HOME'] = str(toolchains / 'rustup')
    result['RUSTUP_TOOLCHAIN'] = json.loads(MANIFEST.read_text())['rust']
    result['RUSTUP_AUTO_INSTALL'] = '0'
    result['PATH'] = os.pathsep.join([str(cargo / 'bin'), str(toolchains / 'python/cmake/data/bin'), result['PATH']])
    result.setdefault('CARGO_BUILD_JOBS', '3')
    result['CARGO_NET_GIT_FETCH_WITH_CLI'] = 'true'
    result['CARGO_PROFILE_DEV_DEBUG'] = '0'
    result['CARGO_PROFILE_DEV_SPLIT_DEBUGINFO'] = 'off'
    result['CARGO_PROFILE_DEV_BUILD_OVERRIDE_DEBUG'] = '0'
    result['CARGO_PROFILE_DEV_BUILD_OVERRIDE_SPLIT_DEBUGINFO'] = 'off'
    result['CARGO_INCREMENTAL'] = '0'
    result['CARGO_TARGET_DIR'] = str(LOCAL / 'native-target')
    result['ZED_COMMIT_SHA'] = json.loads(MANIFEST.read_text())['commit'] + '-eido-local'
    result['EIDO_ROOT'] = str(ROOT)
    result['EIDO_NATIVE_SOURCE_ROOT'] = str(SOURCE)
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js is required; run npm ci first')
    result['EIDO_NODE'] = node
    return result


def fetch_dependencies():
    manifest = json.loads(MANIFEST.read_text())
    archive = LOCAL / 'downloads' / manifest['archiveName']
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists():
        temporary = archive.with_suffix('.partial')
        subprocess.run(['curl', '-fL', '--retry', '3', '--connect-timeout', '20', '-o', str(temporary), manifest['archiveUrl']], check=True)
        if digest(temporary) != manifest['sha256']:
            raise RuntimeError('Downloaded Zed archive does not match the pinned SHA-256')
        temporary.rename(archive)
    prepare()
    env = environment()
    env['CARGO_NET_OFFLINE'] = 'false'
    version = subprocess.check_output(['rustc', '-vV'], env=env, text=True)
    host = next(line.split(': ', 1)[1] for line in version.splitlines() if line.startswith('host: '))
    print('Fetching native dependencies for ' + host, flush=True)
    subprocess.run(['cargo', 'fetch', '--target', host], cwd=SOURCE, env=env, check=True)
    print('Dependency fetch complete. Native checks and builds use Cargo offline mode.', flush=True)


def native_assets():
    spec = importlib.util.spec_from_file_location('eido_native_assets', ROOT / 'scripts/native-assets.py')
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module.validate()


def source_fingerprint():
    prepared = json.loads(STATE.read_text())
    if prepared.get('removedSha256') != digest(ROOT / 'native/removed-paths.json') or prepared.get('upstreamSha256') != digest(MANIFEST):
        raise RuntimeError('Native inputs changed; run npm run native:prepare')
    state = prepared['files']
    overlay_root = ROOT / 'native/overlay'
    for relative in source_files():
        if relative not in state:
            raise RuntimeError('New native source files found; run npm run native:prepare')
    if prepared.get('maintainedFiles') != source_files():
        raise RuntimeError('Native source files changed; run npm run native:prepare')
    for relative, expected in state.items():
        source = SOURCE / relative
        if expected is None:
            if source.exists():
                raise RuntimeError('Deleted native source was recreated outside the overlay: ' + relative)
            continue
        if not source.is_file() or digest(source) != expected:
            raise RuntimeError('Native source differs from the prepared overlay: ' + relative)
        overlay = ROOT / 'native/overlay' / relative
        if overlay.exists() and digest(overlay) != expected:
            raise RuntimeError('Overlay changed; run npm run native:prepare before compiling')
    inputs = {'files': state, 'manifest': digest(MANIFEST), 'removed': digest(ROOT / 'native/removed-paths.json'), 'nativeAssets': digest(ROOT / 'native/assets.json'), 'buildFeatures': BUILD_FEATURES}
    return hashlib.sha256(json.dumps(inputs, sort_keys=True).encode()).hexdigest()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['prepare', 'fetch', 'check', 'build', 'run', 'test-acp', 'test-native'])
    command = parser.parse_args().command
    if command == 'fetch':
        fetch_dependencies()
        return
    if command == 'prepare':
        prepare()
        return
    env = environment()
    env['CARGO_NET_OFFLINE'] = 'true'
    if not STATE.exists():
        raise RuntimeError('Run npm run native:prepare first')
    fingerprint = source_fingerprint()
    env['LK_CUSTOM_WEBRTC'] = str(native_assets())
    env['LK_DEBUG_WEBRTC'] = 'false'
    if command == 'run':
        if not (ROOT / 'packages/acp/node_modules/@earendil-works/pi-coding-agent/dist/index.js').is_file():
            raise RuntimeError('ACP dependencies are missing; run npm run setup:acp')
        record_path = LOCAL / 'native-build.json'
        if not record_path.exists() or json.loads(record_path.read_text())['sourceFingerprint'] != fingerprint:
            raise RuntimeError('No verified build for the current native source; run npm run native:build')
        executable = LOCAL / 'native-target/debug/eido'
        if not executable.exists():
            raise RuntimeError('Run npm run native:build first')
        if digest(executable) != json.loads(record_path.read_text())['binarySha256']:
            raise RuntimeError('Native binary differs from its build record; rebuild before running')
        config = LOCAL / 'native-config'
        config.mkdir(parents=True, exist_ok=True)
        settings = config / 'config/settings.json'
        settings.parent.mkdir(parents=True, exist_ok=True)
        configuration = json.loads(settings.read_text()) if settings.exists() else {}
        # Product appearance defaults do not overwrite user-selected preferences.
        appearance = json.loads((ROOT / 'native/appearance.json').read_text())
        for key, value in appearance.items():
            if isinstance(value, dict) and isinstance(configuration.get(key, {}), dict):
                target = configuration.setdefault(key, {})
                for option, default in value.items():
                    target.setdefault(option, default)
            else:
                configuration.setdefault(key, value)
        configuration.update({
            'telemetry': {'metrics': False, 'diagnostics': False},
            'auto_update': False,
            'disable_ai': False,
            'auto_install_extensions': {'html': False},
            'node': {'path': env['EIDO_NODE'], 'ignore_system_version': False},
        })
        configuration.setdefault('enable_language_server', False)
        configuration.setdefault('agent_servers', {})['eido-pi'] = {
            'type': 'custom',
            'command': env['EIDO_NODE'],
            'args': ['--import', str(ROOT / 'node_modules/tsx/dist/loader.mjs'), str(ROOT / 'packages/acp/src/cli.ts')],
            'env': {'EIDO_ROOT': str(ROOT), 'PI_CODING_AGENT_DIR': str(LOCAL / 'eido')},
        }
        settings.write_text(json.dumps(configuration, indent=2) + '\n')
        bundle = LOCAL / 'native-app/Eido.app/Contents'
        bundle_executable = bundle / 'MacOS/eido'
        bundle_executable.parent.mkdir(parents=True, exist_ok=True)
        if bundle_executable.exists():
            bundle_executable.unlink()
        try:
            os.link(executable, bundle_executable)
        except OSError:
            shutil.copy2(executable, bundle_executable)
        bundle_resources = bundle / 'Resources'
        bundle_resources.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT / 'native/branding/Eido.icns', bundle_resources / 'Eido.icns')
        with (bundle / 'Info.plist').open('wb') as stream:
            plistlib.dump({
                'CFBundleExecutable': 'eido',
                'CFBundleIdentifier': 'dev.eido.local',
                'CFBundleName': 'Eido',
                'CFBundleIconFile': 'Eido.icns',
                'CFBundleDisplayName': 'Eido',
                'CFBundlePackageType': 'APPL',
                'CFBundleShortVersionString': '0.0.1',
                'CFBundleVersion': '2',
                'NSHighResolutionCapable': True,
            }, stream)
        executable = bundle_executable
        subprocess.run([str(executable), '--user-data-dir', str(config), str(ROOT)], env=env, cwd=SOURCE, check=True)
    else:
        cargo_command = command
        targets = ['-p', 'eido_ui'] if command == 'check' else ['-p', 'zed', '--bin', 'eido']
        if command in ('test-acp', 'test-native'):
            cargo_command = 'test'
            targets = ['-p', 'acp_thread', '--lib', 'test_eido_', '--features', 'db/test-support']
            if command == 'test-native':
                targets = ['-p', 'acp_thread', '-p', 'action_log', '-p', 'agent_servers', '-p', 'settings', '-p', 'agent_ui', '-p', 'workspace', '-p', 'gpui_platform', '-p', 'extensions_ui', '--lib', 'test_eido_', '--features', ','.join([*BUILD_FEATURES, 'db/test-support'])]
            env.pop('EIDO_ROOT', None)
        if command == 'build':
            targets += ['--features', ','.join(BUILD_FEATURES)]
        log_path = LOCAL / ('native-' + command + '.log')
        with log_path.open('w') as log:
            process = subprocess.Popen(['cargo', cargo_command, '--offline', '--locked', *targets], env=env, cwd=SOURCE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True)
            for line in process.stdout:
                log.write(line)
                log.flush()
                sys.stdout.write(line)
                sys.stdout.flush()
            if process.wait() != 0:
                raise RuntimeError('Native ' + command + ' failed; see ' + str(log_path))
        if command == 'build':
            binary = LOCAL / 'native-target/debug/eido'
            (LOCAL / 'native-build.json').write_text(json.dumps({'sourceFingerprint': fingerprint, 'binarySha256': digest(binary), 'upstream': json.loads(MANIFEST.read_text()), 'features': BUILD_FEATURES, 'builtAt': datetime.datetime.now(datetime.timezone.utc).isoformat()}, indent=2))


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print('Eido: ' + str(error), file=sys.stderr)
        sys.exit(1)
