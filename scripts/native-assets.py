#!/usr/bin/env python3
import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
import tempfile
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / '.local'
SPEC = ROOT / 'native/assets.json'
STATE = LOCAL / 'native-assets.json'


def digest(path):
    hasher = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            hasher.update(block)
    return hasher.hexdigest()


def required_files(directory):
    files = ['lib/libwebrtc.a', 'webrtc.ninja', 'desktop_capture.ninja', 'include/api/peer_connection_interface.h']
    for relative in files:
        if not (directory / relative).is_file():
            raise RuntimeError('WebRTC package is incomplete: ' + relative)
    architecture = subprocess.check_output(['xcrun', 'lipo', '-archs', str(directory / 'lib/libwebrtc.a')], text=True)
    if 'arm64' not in architecture.split():
        raise RuntimeError('WebRTC library does not contain the required arm64 architecture')


def fetch():
    spec = json.loads(SPEC.read_text())['webrtc']
    metadata_url = 'https://api.github.com/repos/' + spec['repository'] + '/releases/tags/' + spec['tag']
    request = urllib.request.Request(metadata_url, headers={'Accept': 'application/vnd.github+json', 'User-Agent': 'Eido-local-native-setup'})
    with urllib.request.urlopen(request, timeout=30) as response:
        metadata = json.load(response)
    asset = next((asset for asset in metadata['assets'] if asset['name'] == spec['asset']), None)
    if not asset:
        raise RuntimeError('Pinned WebRTC release asset was not found: ' + spec['asset'])
    checksum = asset.get('digest', '')
    if not re.fullmatch(r'sha256:[0-9a-f]{64}', checksum):
        raise RuntimeError('GitHub did not provide a SHA-256 for this asset; preserve the download and request a verification method')
    expected = checksum.removeprefix('sha256:')
    url = 'https://github.com/' + spec['repository'] + '/releases/download/' + spec['tag'] + '/' + spec['asset']
    if asset['browser_download_url'] != url:
        raise RuntimeError('Release asset URL differs from the pinned repository, tag, and filename')
    archive = LOCAL / 'downloads' / spec['asset']
    archive.parent.mkdir(parents=True, exist_ok=True)
    if not archive.exists() or digest(archive) != expected:
        temporary = archive.with_suffix('.partial')
        print('Downloading ' + url, flush=True)
        subprocess.run(['curl', '-fL', '--retry', '3', '--connect-timeout', '20', '-o', str(temporary), url], check=True)
        if digest(temporary) != expected:
            raise RuntimeError('WebRTC archive differs from the release SHA-256')
        temporary.replace(archive)
    destination = LOCAL / 'native-assets' / spec['tag']
    destination.parent.mkdir(parents=True, exist_ok=True)
    if destination.exists():
        validate()
        print('WebRTC package already prepared and verified', flush=True)
        return
    with tempfile.TemporaryDirectory(prefix='eido-webrtc-', dir=destination.parent) as temporary:
        extracted = Path(temporary)
        with zipfile.ZipFile(archive) as package:
            for member in package.infolist():
                path = Path(member.filename)
                mode = member.external_attr >> 16
                if path.is_absolute() or '..' in path.parts or stat.S_ISLNK(mode):
                    raise RuntimeError('WebRTC archive contains an unsupported path or symbolic link: ' + member.filename)
            package.extractall(extracted)
        library = extracted / spec['directory']
        required_files(library)
        hashes = {str(path.relative_to(extracted)): digest(path) for path in extracted.rglob('*') if path.is_file()}
        shutil.move(str(extracted), destination)
    STATE.write_text(json.dumps({'specSha256': digest(SPEC), 'archiveSha256': expected, 'asset': spec, 'files': hashes}, indent=2) + '\n')
    print('WebRTC native package verified and prepared. Resume native:check.', flush=True)


def validate():
    if not STATE.exists():
        raise RuntimeError('WebRTC native package is missing. Manually run npm run native:fetch-assets first.')
    record = json.loads(STATE.read_text())
    spec = json.loads(SPEC.read_text())['webrtc']
    if record.get('specSha256') != digest(SPEC) or record.get('asset') != spec:
        raise RuntimeError('WebRTC package does not match the pinned native asset specification')
    archive = LOCAL / 'downloads' / spec['asset']
    if not archive.is_file() or digest(archive) != record['archiveSha256']:
        raise RuntimeError('WebRTC archive is missing or differs from its verified receipt')
    destination = LOCAL / 'native-assets' / spec['tag']
    for relative, expected in record['files'].items():
        path = destination / relative
        if not path.is_file() or path.is_symlink() or digest(path) != expected:
            raise RuntimeError('WebRTC package has changed: ' + relative)
    directory = destination / spec['directory']
    required_files(directory)
    return directory


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['fetch', 'verify'])
    if parser.parse_args().command == 'fetch':
        fetch()
    else:
        print(validate())


if __name__ == '__main__':
    try:
        main()
    except RuntimeError as error:
        print('Eido: ' + str(error), file=sys.stderr)
        sys.exit(1)
