#!/usr/bin/env python3
"""Keep local development documents out of commits and outgoing history."""

import re
import subprocess
import sys
from pathlib import PurePosixPath


PRIVATE_DIRECTORIES = {"local-docs", ".local", "private-docs", "internal-docs"}
DOCUMENT_EXTENSIONS = {".md", ".markdown", ".mdx", ".doc", ".docx", ".docm"}
LEGAL_NOTICES = {"license.md", "licence.md", "copying.md", "notice.md", "copyright.md"}


def git(*args):
    return subprocess.check_output(["git", *args], stderr=subprocess.PIPE)


def private_document(path):
    normalized = PurePosixPath(path.casefold())
    if PRIVATE_DIRECTORIES.intersection(normalized.parts[:-1]):
        return True
    if normalized.name in LEGAL_NOTICES:
        return False
    return normalized.suffix in DOCUMENT_EXTENSIONS


def paths_from(output):
    return [path.decode("utf-8", "surrogateescape") for path in output.split(b"\0") if path]


def staged_violations():
    paths = paths_from(git("diff", "--cached", "--name-only", "--diff-filter=ACMRT", "-z"))
    return {path: "staged" for path in paths if private_document(path)}


def checked_commit(oid):
    if not re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", oid):
        raise ValueError("Invalid object ID in push input")
    if not oid.strip("0"):
        return None
    return git("rev-parse", "--verify", f"{oid}^{{commit}}").decode().strip()


def push_violations():
    violations = {}
    inspected = set()
    for line in sys.stdin:
        fields = line.split()
        if len(fields) != 4:
            raise ValueError("Invalid pre-push input")
        _, local_oid, _, remote_oid = fields
        local_commit = checked_commit(local_oid)
        if local_commit is None:
            continue
        exclusions = []
        try:
            remote_commit = checked_commit(remote_oid)
            if remote_commit:
                exclusions.append(f"^{remote_commit}")
        except subprocess.CalledProcessError:
            # Missing remote history: inspect all local ancestors, failing closed.
            pass
        commits = git("rev-list", local_commit, *exclusions).decode().splitlines()
        for commit in commits:
            if commit in inspected:
                continue
            inspected.add(commit)
            # Inspect each outgoing commit's complete tree, including merge results.
            # A later deletion cannot hide a document from an earlier commit.
            paths = paths_from(git("ls-tree", "-r", "--name-only", "-z", commit))
            for path in paths:
                if private_document(path):
                    violations.setdefault(path, commit[:12])
    return violations


def main():
    if len(sys.argv) != 2 or sys.argv[1] not in {"staged", "push"}:
        print("Usage: check-private-docs.py staged|push", file=sys.stderr)
        return 2
    try:
        violations = staged_violations() if sys.argv[1] == "staged" else push_violations()
    except (subprocess.CalledProcessError, ValueError) as error:
        print(f"Eido document guard could not finish: {error}", file=sys.stderr)
        return 2
    if not violations:
        return 0
    print("Eido blocked local development documents:", file=sys.stderr)
    for path, location in sorted(violations.items()):
        print(f"  {path!r} [{location}]", file=sys.stderr)
    print("Keep development notes and standards in ignored local-docs/.", file=sys.stderr)
    if sys.argv[1] == "push":
        print("Documents must also be absent from every outgoing commit, not only HEAD.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    sys.exit(main())
