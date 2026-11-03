#!/usr/bin/env python3
"""
Writes the vmlinux part of Module.symvers from a released kernel: the export
tables (__ksymtab, __ksymtab_gpl) and their CRCs (__kcrctab, __kcrctab_gpl) in
the arm64 Image, located with System.map. Then checks the CRCs against the
__versions sections of the kernel's own modules.

usage: symvers.py <Image> <System.map> <modules dir> > Module.symvers
"""
import os
import struct
import sys


def symbols(path):
    syms = {}
    with open(path) as f:
        for line in f:
            addr, _, name = line.split()
            syms[name] = int(addr, 16)
    return syms


def cstring(image, off):
    return image[off:image.index(b"\0", off)].decode()


def exports(image, syms):
    text = syms["_text"]
    out = {}
    for gpl in ("", "_gpl"):
        start = syms[f"__start___ksymtab{gpl}"]
        stop = syms[f"__stop___ksymtab{gpl}"]
        crcs = syms[f"__start___kcrctab{gpl}"] - text
        for i, addr in enumerate(range(start, stop, 12)):
            # struct kernel_symbol with PREL32 relocations: value, name, namespace
            off = addr - text
            _, name_off, ns_off = struct.unpack_from("<iii", image, off)
            name = cstring(image, off + 4 + name_off)
            ns = cstring(image, off + 8 + ns_off)
            (crc,) = struct.unpack_from("<I", image, crcs + 4 * i)
            out[name] = (crc, "EXPORT_SYMBOL_GPL" if gpl else "EXPORT_SYMBOL", ns)
    return out


def versions(ko):
    """CRCs a module recorded for the symbols it imports (BASIC_MODVERSIONS)."""
    data = open(ko, "rb").read()
    if data[:4] != b"\x7fELF" or data[4] != 2:
        return {}
    shoff, = struct.unpack_from("<Q", data, 0x28)
    shentsize, shnum, shstrndx = struct.unpack_from("<HHH", data, 0x3A)
    sections = [struct.unpack_from("<IIQQQQIIQQ", data, shoff + i * shentsize) for i in range(shnum)]
    strtab = sections[shstrndx][4]
    for s in sections:
        if cstring(data, strtab + s[0]) == "__versions":
            body = data[s[4]:s[4] + s[5]]
            return {
                body[i + 8:i + 64].split(b"\0")[0].decode(): struct.unpack_from("<Q", body, i)[0] & 0xFFFFFFFF
                for i in range(0, len(body), 64)
            }
    return {}


def main():
    image = open(sys.argv[1], "rb").read()
    table = exports(image, symbols(sys.argv[2]))

    checked = 0
    for root, _, files in os.walk(sys.argv[3]):
        for f in files:
            if not f.endswith(".ko"):
                continue
            for name, crc in versions(os.path.join(root, f)).items():
                if name in table:
                    if table[name][0] != crc:
                        sys.exit(f"CRC mismatch for {name} in {f}: {table[name][0]:#010x} != {crc:#010x}")
                    checked += 1
    if checked == 0:
        sys.exit("no module CRCs to check against")
    print(f"{len(table)} exports, {checked} CRCs checked against the kernel's modules", file=sys.stderr)

    for name, (crc, kind, ns) in sorted(table.items()):
        print(f"0x{crc:08x}\t{name}\tvmlinux\t{kind}\t{ns}")


main()
