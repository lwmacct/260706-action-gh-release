import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";

const TAR_EXTENSIONS = [".tar.gz", ".tar.xz", ".tar.bz2", ".tgz"] as const;
const WINDOWS_EXECUTABLE_PATTERN = /\.(?:exe|cmd|bat|ps1)$/i;
const SUPPLEMENTAL_ASSET_PATTERN = /\.(?:asc|sig|sha256|sha256sum|sha512|sha512sum|checksums?|intoto\.jsonl|spdx\.json|sbom\.json|txt)$/i;

export function normalizeChecksum(value: string): string {
  const checksum = value.trim().toLowerCase().replace(/^sha256:/, "");
  if (!checksum) {
    return "";
  }
  if (!/^[a-f0-9]{64}$/.test(checksum)) {
    throw new Error("checksum must be a SHA256 hex digest, optionally prefixed with sha256:");
  }
  return checksum;
}

export function normalizeRename(value: string): string {
  const rename = value.trim();
  if (!rename) {
    return "";
  }
  if (rename.includes("/") || rename.includes("\\") || rename !== path.basename(rename)) {
    throw new Error("rename must be a file name, not a path");
  }
  return rename;
}

export function platformAliases(platform: NodeJS.Platform): string[] {
  switch (platform) {
    case "linux":
      return ["linux"];
    case "darwin":
      return ["darwin", "macos", "mac-os", "mac_os", "osx", "apple-darwin"];
    case "win32":
      return ["windows", "win32", "win64", "pc-windows", "mingw"];
    default:
      throw new Error(`Unsupported runner platform: ${platform}`);
  }
}

export function architectureAliases(arch: string): string[] {
  switch (arch) {
    case "x64":
      return ["x86_64", "x64", "amd64"];
    case "arm64":
      return ["aarch64", "arm64"];
    default:
      return [arch.toLowerCase()];
  }
}

export function includesAny(value: string, aliases: string[]): boolean {
  return aliases.some((alias) => value.includes(alias));
}

export function tarFlags(assetName: string): string | undefined {
  const normalized = assetName.toLowerCase();
  if (normalized.endsWith(".tar.xz")) {
    return "xJ";
  }
  if (normalized.endsWith(".tar.bz2")) {
    return "xj";
  }
  return undefined;
}

export function listFiles(root: string): string[] {
  const files: string[] = [];
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop();
    if (!directory) {
      continue;
    }
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        files.push(entryPath);
      }
    }
  }
  return files.sort();
}

export function isLikelyExecutable(filePath: string): boolean {
  if (os.platform() === "win32") {
    return WINDOWS_EXECUTABLE_PATTERN.test(filePath);
  }
  return (fs.statSync(filePath).mode & 0o111) !== 0;
}

export function isArchive(assetName: string): boolean {
  const normalized = assetName.toLowerCase();
  return normalized.endsWith(".zip") || TAR_EXTENSIONS.some((extension) => normalized.endsWith(extension));
}

export async function hashFile(filePath: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  return hash.digest("hex");
}

export function verifySha256(actualChecksum: string, expectedChecksum: string): void {
  if (actualChecksum !== expectedChecksum) {
    throw new Error(`SHA256 mismatch. Expected ${expectedChecksum}, got ${actualChecksum}`);
  }
}

export function chmodExecutable(filePath: string): void {
  if (os.platform() !== "win32") {
    fs.chmodSync(filePath, 0o755);
  }
}

export function moveFile(source: string, target: string): void {
  try {
    fs.renameSync(source, target);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EXDEV") {
      fs.copyFileSync(source, target);
      fs.rmSync(source);
      return;
    }
    throw error;
  }
}

export function isMovingTag(tag: string): boolean {
  return tag === "latest" || tag === "latest-prerelease";
}

export function isSupplementalAsset(assetName: string): boolean {
  return SUPPLEMENTAL_ASSET_PATTERN.test(assetName.toLowerCase());
}

export function matchesGlob(value: string, pattern: string): boolean {
  return globToRegExp(pattern).test(value);
}

export function normalizePath(value: string): string {
  return value.replace(/\\/g, "/").split(path.sep).join("/");
}

export function relativeNames(root: string, files: string[]): string[] {
  return files.map((file) => normalizePath(path.relative(root, file)));
}

export function relativeMetadataPath(root: string, target: string): string {
  const relativePath = normalizePath(path.relative(root, target));
  return relativePath || ".";
}

export function formatNames(names: string[]): string {
  return names.length === 0 ? "(none)" : names.join(", ");
}

export function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function sanitizePathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "asset";
}

function globToRegExp(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") {
      source += ".*";
    } else if (character === "?") {
      source += ".";
    } else {
      source += escapeRegExp(character);
    }
  }
  source += "$";
  return new RegExp(source, "i");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
