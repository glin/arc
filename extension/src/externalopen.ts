import * as fs from 'node:fs';

const SAMPLE_BYTES = 512;
const excludedSuffixes = new Set(
  (
    'exe com scr pif cpl dll sys drv ocx msi msp mst msix msixbundle appx appxbundle appinstaller application manifest ' +
    'bat cmd ps1 ps1xml ps2 ps2xml psc1 psc2 vbs vbe js jse wsf wsh hta reg inf ins isp sct ' +
    'lnk url website desktop app command sh bash zsh fish py pyw rb pl php jar class jnlp scpt applescript workflow action ' +
    'iso img vhd vhdx dmg pkg mpkg'
  ).split(' '),
);
const excludedSignatures = [
  [0x4d, 0x5a],
  [0x7f, 0x45, 0x4c, 0x46],
  [0xfe, 0xed, 0xfa, 0xce],
  [0xfe, 0xed, 0xfa, 0xcf],
  [0xce, 0xfa, 0xed, 0xfe],
  [0xcf, 0xfa, 0xed, 0xfe],
  [0xca, 0xfe, 0xba, 0xbe],
  [0xbe, 0xba, 0xfe, 0xca],
  [0xca, 0xfe, 0xba, 0xbf],
  [0xbf, 0xba, 0xfe, 0xca],
  [0x4c, 0x00, 0x00, 0x00, 0x01, 0x14, 0x02, 0x00],
  [0x23, 0x21],
];
const byteOrderMarks = [
  [0xef, 0xbb, 0xbf],
  [0xff, 0xfe],
  [0xfe, 0xff],
  [0xff, 0xfe, 0x00, 0x00],
  [0x00, 0x00, 0xfe, 0xff],
];

export function externalOpenPath(file: string): boolean {
  const name = file.split(/[\\/]/).at(-1)!;
  const dot = name.lastIndexOf('.');
  return dot < 0 || !excludedSuffixes.has(name.slice(dot + 1).toLowerCase());
}

export function externalOpenSample(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, SAMPLE_BYTES);
  if (sample.length < 2 || !sample.includes(0)) return false;
  if (byteOrderMarks.some((mark) => mark.slice(0, sample.length).every((byte, i) => sample[i] === byte))) return false;
  if (excludedSignatures.some((signature) => signature.every((byte, i) => sample[i] === byte))) return false;
  const littleEndian = sample.every((byte, i) => (i % 2 === 0 ? byte !== 0 : byte === 0));
  const bigEndian = sample.every((byte, i) => (i % 2 === 0 ? byte === 0 : byte !== 0));
  return !littleEndian && !bigEndian;
}

interface ExternalFileStat {
  isFile(): boolean;
  mode: number;
}

interface ExternalFileHandle {
  stat(): Promise<ExternalFileStat>;
  read(buffer: Buffer, offset: number, length: number, position: number): Promise<{ bytesRead: number }>;
  close(): Promise<void>;
}

export interface ExternalOpenFs {
  constants: Pick<typeof fs.constants, 'O_RDONLY' | 'O_NONBLOCK'>;
  lstat(file: string): Promise<ExternalFileStat & { isSymbolicLink(): boolean }>;
  open(file: string, flags: number): Promise<ExternalFileHandle>;
}

export async function externalOpenEligible(
  file: string,
  platform: NodeJS.Platform = process.platform,
  io: ExternalOpenFs = { constants: fs.constants, lstat: fs.promises.lstat, open: fs.promises.open },
): Promise<boolean> {
  if (!externalOpenPath(file)) return false;
  const regularDocument = (stat: ExternalFileStat) =>
    stat.isFile() && (platform === 'win32' || (stat.mode & 0o111) === 0);
  try {
    const before = await io.lstat(file);
    if (before.isSymbolicLink() || !regularDocument(before)) return false;
    const handle = await io.open(file, io.constants.O_RDONLY | (platform === 'win32' ? 0 : io.constants.O_NONBLOCK));
    try {
      if (!regularDocument(await handle.stat())) return false;
      const bytes = Buffer.alloc(SAMPLE_BYTES);
      let have = 0;
      while (have < bytes.length) {
        const { bytesRead } = await handle.read(bytes, have, bytes.length - have, have);
        if (!bytesRead) break;
        have += bytesRead;
      }
      return externalOpenSample(bytes.subarray(0, have));
    } finally {
      await handle.close();
    }
  } catch {
    return false;
  }
}
