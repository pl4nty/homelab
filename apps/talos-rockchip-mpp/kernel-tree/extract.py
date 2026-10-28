#!/usr/bin/env python3
"""
Writes the raw arm64 Image out of a Talos vmlinuz: an EFI zboot image with a
zstd payload, whose offset and size are in its header.

usage: extract.py <vmlinuz> <Image>
"""
import struct
import subprocess
import sys

data = open(sys.argv[1], "rb").read()
if data[:2] != b"MZ" or data[4:8] != b"zimg":
    sys.exit("not an EFI zboot image")
offset, size = struct.unpack_from("<II", data, 8)
comp = data[24:32].rstrip(b"\0").decode()
if comp != "zstd":
    sys.exit(f"unsupported zboot compression {comp}")
subprocess.run(["zstd", "-q", "-d", "-o", sys.argv[2]], input=data[offset:offset + size], check=True)
